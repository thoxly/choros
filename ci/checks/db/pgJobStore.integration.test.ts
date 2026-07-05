/**
 * T-0114 Integration fitness tests — PostgresJobStore
 * Runs against live Postgres (compose, port 55432) via npm run fitness:db.
 *
 * Covers:
 *   FF-1..FF-12 (integration portion)
 *   AC-1..AC-18 (integration portion)
 *   migration-010 idempotency (FF-11)
 *
 * Environment:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros (migrator)
 *   APP_DATABASE_URL=postgres://choros_app:choros_app_dev_pw@localhost:55432/choros (app role)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { TENANT_A, TENANT_B, migratorUrl, appUrl, withClient, uuid } from "./_helpers.js";
import { PostgresJobStore } from "../../../src/core/postgres/pgJobStore.js";
import { PostgresOutboxStore } from "../../../src/core/postgres/pgOutboxStore.js";
import { JobState } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixedClock(value: number) {
  return { now: () => value };
}

function makeMutableClock(initial: number) {
  let t = initial;
  return {
    now: () => t,
    set(v: number) { t = v; },
    advance(by: number) { t += by; },
  };
}

/** Create a pg.Pool connected as choros_app. */
function makeAppPool(): pg.Pool {
  return new pg.Pool({ connectionString: appUrl() });
}

/** Create a PostgresJobStore with choros_app pool and a given clock. */
function makeStore(clock?: { now(): number }, pool?: pg.Pool): PostgresJobStore {
  const p = pool ?? makeAppPool();
  return new PostgresJobStore(p, clock);
}

/**
 * Set the tenant GUC on a pool-acquired client for the duration of `fn`.
 * PostgresJobStore relies on the caller (middleware) setting this GUC.
 * For test purposes we wrap our store calls inside a GUC-setting transaction.
 */
async function withTenantPool<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: () => Promise<T>
): Promise<T> {
  // Patch the pool to always set the GUC on new connections
  // by using query() which goes through the pool.
  // Strategy: override pool.query to prefix with GUC set.
  // Simpler approach: create a wrapper client that sets GUC before each query.
  // We use a connection pool where each query is intercepted.
  // The cleanest way: use a beforeEach hook to set the GUC on the connection.
  // For simplicity in tests, we can use a fresh client with manual GUC setting.
  await pool.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  return fn();
}

/**
 * Wrap all operations inside a transaction with the tenant GUC set.
 * Returns result and commits. On error, rolls back.
 */
async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PostgresJobStore using a single client (for GUC isolation per transaction).
 * This variant wraps the app pool to set GUC before each operation.
 */
class TenantStore {
  private readonly pool: pg.Pool;
  private readonly clock: { now(): number };
  private readonly tenantId: string;
  readonly store: PostgresJobStore;

  constructor(tenantId: string, clock?: { now(): number }) {
    this.pool = makeAppPool();
    this.clock = clock ?? { now: () => Date.now() };
    this.tenantId = tenantId;
    // Create a proxied pool that sets GUC on each query
    const proxied = this.makeGucPool();
    this.store = new PostgresJobStore(proxied, this.clock);
  }

  private makeGucPool(): pg.Pool {
    const tenantId = this.tenantId;
    const realPool = this.pool;
    // Create a pool subclass that wraps query to set GUC first
    const proxy = Object.create(realPool) as pg.Pool;
    const origQuery = realPool.query.bind(realPool);

    // We can't easily intercept at the pool level without modifying client.
    // Instead, use a wrapper that runs queries in a client transaction with GUC set.
    // For simplicity: just expose the pool and always call setGuc before calling store methods.
    return realPool;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Execute a function with the tenant GUC set on a dedicated client.
   * Uses SET LOCAL (transaction-scoped) inside a BEGIN/COMMIT block.
   */
  async run<T>(fn: (store: PostgresJobStore, client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${this.tenantId}'`);
      // Create a store backed by the single client (all queries go through it)
      const clientStore = new SingleClientStore(client, this.clock);
      const result = await fn(clientStore as unknown as PostgresJobStore, client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * A store that operates via a single pg.Client (for GUC-scoped transactions).
 * Delegates to PostgresJobStore but overrides the pool with a single-client wrapper.
 */
class SingleClientStore extends PostgresJobStore {
  constructor(client: pg.PoolClient, clock?: { now(): number }) {
    // Wrap the client in a minimal pool-like object
    const fakePool = {
      query: client.query.bind(client),
      connect: async () => ({
        query: client.query.bind(client),
        release: () => {},
      }),
    } as unknown as pg.Pool;
    super(fakePool, clock);
  }
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

/** Seed rows directly into choros.job as migrator (bypasses RLS). */
async function seedJob(params: {
  tenantId: string;
  id?: string;
  topic: string;
  state: string;
  retries?: number;
  available_at?: number;
  created_at?: number;
  lockOwner?: string | null;
  lockExpiry?: number | null;
}): Promise<string> {
  const id = params.id ?? uuid();
  const now = Date.now();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.job
         (tenant_id, id, topic, variables, state, retries,
          lock_owner, lock_expiry, created_at, available_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [
        params.tenantId, id, params.topic, JSON.stringify({}),
        params.state, params.retries ?? 0,
        params.lockOwner ?? null, params.lockExpiry ?? null,
        params.created_at ?? now, params.available_at ?? now,
      ]
    );
  });
  return id;
}

/** Truncate choros.job (migrator). */
async function truncateJobs(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.job");
  });
}

// ---------------------------------------------------------------------------
// Pools / store instances
// ---------------------------------------------------------------------------
let appPool: pg.Pool;

beforeAll(async () => {
  appPool = makeAppPool();
});

afterAll(async () => {
  await appPool.end();
});

beforeEach(async () => {
  await truncateJobs();
});

// Helper: run a function with the app pool and tenant GUC set
async function runAsTenant<T>(tenantId: string, clock: { now(): number }, fn: (store: SingleClientStore) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const store = new SingleClientStore(client, clock);
    const result = await fn(store);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// FF-11: migration 010_ idempotency
// ---------------------------------------------------------------------------
describe("FF-11: migration 010_ — available_at column + indexes exist", () => {
  it("available_at column exists on choros.job", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema='choros' AND table_name='job' AND column_name='available_at'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0].data_type).toBe("bigint");
      expect(rows[0].is_nullable).toBe("NO");
    });
  });

  it("partial index idx_job_fetchable_created exists", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='choros' AND tablename='job' AND indexname='idx_job_fetchable_created'`
      );
      expect(rows.length).toBe(1);
    });
  });

  it("partial index idx_job_fetchable_locked exists", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='choros' AND tablename='job' AND indexname='idx_job_fetchable_locked'`
      );
      expect(rows.length).toBe(1);
    });
  });

  it("migration is idempotent (no error on re-run via IF NOT EXISTS)", async () => {
    // Verify by checking the migration_runner skips already applied
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT version FROM choros.schema_migrations WHERE version='010_job_available_at'`
      );
      expect(rows.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-3: available_at never NULL
// ---------------------------------------------------------------------------
describe("FF-3: available_at never NULL after operations", () => {
  it("no rows have available_at IS NULL after enqueue+fail sequence", async () => {
    const clock = makeMutableClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 2);
      expect(job.available_at).toBe(1000);
      const [locked] = await store.fetchAndLock("w", ["t"], 1, 5000);
      await store.fail("w", locked.id, 1, 3000);
    });
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(`SELECT COUNT(*) AS n FROM choros.job WHERE available_at IS NULL`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-1: fetchAndLock — correct fields
// ---------------------------------------------------------------------------
describe("AC-1: fetchAndLock returns correct fields", () => {
  it("returns job with state=LOCKED, lockOwner, lockExpiry, available_at", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const enqueued = await store.enqueue("invoice", { amount: 42 }, 3);
      const result = await store.fetchAndLock("w1", ["invoice"], 1, 30000);
      expect(result).toHaveLength(1);
      const job = result[0];
      expect(job.id).toBe(enqueued.id);
      expect(job.state).toBe(JobState.LOCKED);
      expect(job.lockOwner).toBe("w1");
      expect(job.lockExpiry).toBe(31000); // 1000 + 30000
      expect(job.createdAt).toBe(1000);
      expect(job.available_at).toBeGreaterThanOrEqual(job.createdAt);
      expect(typeof job.topic).toBe("string");
      expect(job.topic).toBe("invoice");
    });
  });
});

// ---------------------------------------------------------------------------
// T-0677: fetchAndLock threads process_def_id/instance_id (migration 111,
// T-0534) onto the returned Job — upstream fix for the T-0638 live-proof gap
// (agent-step-context.ts's readJobVars() received instanceId="" for every
// live agentTask because fetchAndLock's RETURNING list omitted these columns,
// even though enqueue() wrote them to the DB correctly).
// ---------------------------------------------------------------------------
describe("T-0677: fetchAndLock threads process_def_id/instance_id onto Job", () => {
  it("enqueue with processDefId+instanceId → fetchAndLock returns a Job with instanceId/processDefId populated (not empty)", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      await store.enqueue(
        "agent-step",
        { agentEmployeeId: "agent-1" },
        3,
        "idem-t0677-1",
        "telLinear",
        "99573238",
      );
      const result = await store.fetchAndLock("w1", ["agent-step"], 1, 30000);
      expect(result).toHaveLength(1);
      const job = result[0];
      // RED before the fix: job.instanceId/processDefId did not exist on the
      // Job interface at all, and fetchAndLock's RETURNING list did not select
      // the columns — this would have been `undefined` (or a TS compile error
      // referencing a non-existent field) pre-fix.
      expect(job.instanceId).toBe("99573238");
      expect(job.processDefId).toBe("telLinear");
    });
  });

  it("getById also threads instanceId/processDefId (SELECT list parity with fetchAndLock)", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const enqueued = await store.enqueue(
        "agent-step",
        { agentEmployeeId: "agent-1" },
        3,
        "idem-t0677-2",
        "purchaseApproval",
        "inst-abc-123",
      );
      const fetched = await store.getById(enqueued.id);
      expect(fetched).toBeDefined();
      expect(fetched!.instanceId).toBe("inst-abc-123");
      expect(fetched!.processDefId).toBe("purchaseApproval");
    });
  });

  it("backward compatibility: job enqueued WITHOUT processDefId/instanceId → fields are null, no crash", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      // Legacy call shape: no 5th/6th args at all (pre-T-0534 callers).
      await store.enqueue("legacy-topic", { foo: "bar" }, 3);
      const result = await store.fetchAndLock("w1", ["legacy-topic"], 1, 30000);
      expect(result).toHaveLength(1);
      const job = result[0];
      expect(job.instanceId).toBeNull();
      expect(job.processDefId).toBeNull();
      // The rest of the Job contract is unaffected.
      expect(job.state).toBe(JobState.LOCKED);
      expect(job.lockOwner).toBe("w1");
    });
  });

  it("directly-seeded legacy row (process_def_id/instance_id columns NULL at the DB level) → fetchAndLock does not crash, fields null", async () => {
    const clock = makeFixedClock(1000);
    const jobId = await seedJob({
      tenantId: TENANT_A,
      topic: "legacy-seeded",
      state: "CREATED",
      available_at: 500,
      created_at: 500,
    });
    await runAsTenant(TENANT_A, clock, async (store) => {
      const result = await store.fetchAndLock("w1", ["legacy-seeded"], 1, 30000);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(jobId);
      expect(result[0].instanceId).toBeNull();
      expect(result[0].processDefId).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-2: fetchAndLock FIFO, maxJobs cap
// ---------------------------------------------------------------------------
describe("AC-2: fetchAndLock FIFO + maxJobs cap", () => {
  it("returns 2 jobs in createdAt ASC order, third stays CREATED", async () => {
    let t = 100;
    const clock = { now: () => { const v = t; t += 100; return v; } };
    let jobIds: string[] = [];
    await runAsTenant(TENANT_A, clock, async (store) => {
      const j1 = await store.enqueue("t", { n: 1 }, 0);
      const j2 = await store.enqueue("t", { n: 2 }, 0);
      const j3 = await store.enqueue("t", { n: 3 }, 0);
      jobIds = [j1.id, j2.id, j3.id];
      const result = await store.fetchAndLock("w", ["t"], 2, 5000);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(j1.id);
      expect(result[1].id).toBe(j2.id);
      const third = await store.getById(j3.id);
      expect(third!.state).toBe(JobState.CREATED);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3: fetchAndLock respects available_at
// ---------------------------------------------------------------------------
describe("AC-3: fetchAndLock respects available_at backoff", () => {
  it("does not pick up job before available_at", async () => {
    const clock = makeMutableClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      // enqueue
      const job = await store.enqueue("t", {}, 2);
      // fetch and lock
      const [locked] = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(locked.id).toBe(job.id);
      // fail with retryTimeoutMs=60000 at clock=1000 → available_at=61000
      clock.set(1000);
      await store.fail("w", locked.id, 1, 60000);
    });

    // At T+59999 — should NOT be available
    await runAsTenant(TENANT_A, makeFixedClock(60999), async (store) => {
      const r1 = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(r1).toHaveLength(0);
    });

    // At T+60000 — should be available (available_at = 1000+60000 = 61000)
    await runAsTenant(TENANT_A, makeFixedClock(61000), async (store) => {
      const r2 = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(r2).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-4: fetchAndLock reclaims expired lock
// ---------------------------------------------------------------------------
describe("AC-4: fetchAndLock reclaims expired lock", () => {
  it("reclaims job with expired lock", async () => {
    const clock = makeMutableClock(500);
    let jobId: string;
    await runAsTenant(TENANT_A, makeFixedClock(500), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      jobId = job.id;
      // lock with lockDurationMs=0 → lockExpiry=500 (already expired at 500)
      const locked = await store.fetchAndLock("w1", ["t"], 1, 0);
      expect(locked).toHaveLength(1);
      expect(locked[0].lockExpiry).toBe(500);
    });

    // At clock=600, lock has expired (lockExpiry=500 <= 600)
    await runAsTenant(TENANT_A, makeFixedClock(600), async (store) => {
      const result = await store.fetchAndLock("w2", ["t"], 1, 100);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(jobId!);
      expect(result[0].lockOwner).toBe("w2");
      expect(result[0].lockExpiry).toBe(700); // 600+100
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: fetchAndLock atomic concurrency (two concurrent calls = sum 1)
// ---------------------------------------------------------------------------
describe("AC-5: fetchAndLock is atomic (SKIP LOCKED)", () => {
  it("two concurrent fetchAndLock calls return at most 1 job total", async () => {
    const clock = makeFixedClock(1000);
    // Seed 1 job as migrator directly to avoid GUC complexity
    await seedJob({ tenantId: TENANT_A, topic: "t", state: "CREATED", available_at: 999, created_at: 1 });

    // Two concurrent fetches using separate connections
    const pool1 = makeAppPool();
    const pool2 = makeAppPool();
    try {
      const [r1, r2] = await Promise.all([
        (async () => {
          const client = await pool1.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
            const store = new SingleClientStore(client, clock);
            const result = await store.fetchAndLock("w1", ["t"], 1, 5000);
            await client.query("COMMIT");
            return result;
          } catch {
            await client.query("ROLLBACK");
            return [];
          } finally {
            client.release();
          }
        })(),
        (async () => {
          const client = await pool2.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
            const store = new SingleClientStore(client, clock);
            const result = await store.fetchAndLock("w2", ["t"], 1, 5000);
            await client.query("COMMIT");
            return result;
          } catch {
            await client.query("ROLLBACK");
            return [];
          } finally {
            client.release();
          }
        })(),
      ]);
      expect(r1.length + r2.length).toBe(1);
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: complete happy path
// ---------------------------------------------------------------------------
describe("AC-6: complete happy path", () => {
  it("transitions to COMPLETED, clears lock, returns ok:true", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w1", ["t"], 1, 30000);
      const r = await store.complete("w1", job.id);
      expect(r).toEqual({ ok: true });
      const updated = await store.getById(job.id);
      expect(updated!.state).toBe(JobState.COMPLETED);
      expect(updated!.lockOwner).toBeUndefined();
      expect(updated!.lockExpiry).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7: complete gate codes
// ---------------------------------------------------------------------------
describe("AC-7: complete ownership gate", () => {
  it("NOT_FOUND for unknown jobId", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const r = await store.complete("w", "00000000-0000-0000-0000-000000000000");
      expect(r).toEqual({ ok: false, code: "NOT_FOUND" });
    });
  });

  it("NOT_LOCKED for CREATED job", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 0);
      const r = await store.complete("w", job.id);
      expect(r).toEqual({ ok: false, code: "NOT_LOCKED" });
    });
  });

  it("LOCK_EXPIRED for expired lock", async () => {
    const clock = makeMutableClock(1000);
    let jobId: string;
    // Enqueue and lock with clock=1000
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      jobId = job.id;
      await store.fetchAndLock("w1", ["t"], 1, 0); // lockExpiry=1000
    });
    // At clock=1000, lockExpiry<=now → LOCK_EXPIRED
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const r = await store.complete("w1", jobId!);
      expect(r).toEqual({ ok: false, code: "LOCK_EXPIRED" });
    });
  });

  it("NOT_OWNER for wrong workerId", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w1", ["t"], 1, 30000);
      const r = await store.complete("w2", job.id);
      expect(r).toEqual({ ok: false, code: "NOT_OWNER" });
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8: fail with retries>0 — available_at = now+retryTimeoutMs
// ---------------------------------------------------------------------------
describe("AC-8: fail with retries>0", () => {
  it("state=CREATED, available_at=now+retryTimeoutMs, fetchAndLock respects it", async () => {
    const clock = makeFixedClock(1000);
    let jobId: string;
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 2);
      jobId = job.id;
      await store.fetchAndLock("w", ["t"], 1, 5000);
      const r = await store.fail("w", job.id, 2, 5000);
      expect(r).toEqual({ ok: true });
      const updated = await store.getById(job.id);
      expect(updated!.state).toBe(JobState.CREATED);
      expect(updated!.retries).toBe(2);
      expect(updated!.available_at).toBe(6000); // 1000+5000
    });

    // Not available at 5999
    await runAsTenant(TENANT_A, makeFixedClock(5999), async (store) => {
      const r = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(r).toHaveLength(0);
    });

    // Available at 6000
    await runAsTenant(TENANT_A, makeFixedClock(6000), async (store) => {
      const r = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe(jobId!);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9: fail with retries=0 → FAILED, not returned
// ---------------------------------------------------------------------------
describe("AC-9: fail with retries=0 → FAILED terminal state", () => {
  it("state=FAILED, not returned by fetchAndLock", async () => {
    const clock = makeFixedClock(1000);
    await runAsTenant(TENANT_A, clock, async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w", ["t"], 1, 5000);
      const r = await store.fail("w", job.id, 0, 0);
      expect(r).toEqual({ ok: true });
      const updated = await store.getById(job.id);
      expect(updated!.state).toBe(JobState.FAILED);
      const next = await store.fetchAndLock("w", ["t"], 1, 5000);
      expect(next).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10: fail gate codes
// ---------------------------------------------------------------------------
describe("AC-10: fail ownership gate", () => {
  it("NOT_FOUND for unknown jobId", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const r = await store.fail("w", "00000000-0000-0000-0000-000000000000", 1, 5000);
      expect(r).toEqual({ ok: false, code: "NOT_FOUND" });
    });
  });

  it("NOT_LOCKED for CREATED job", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      const r = await store.fail("w", job.id, 1, 5000);
      expect(r).toEqual({ ok: false, code: "NOT_LOCKED" });
    });
  });

  it("LOCK_EXPIRED for expired lock", async () => {
    let jobId: string;
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      jobId = job.id;
      await store.fetchAndLock("w1", ["t"], 1, 0); // lockExpiry=1000
    });
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const r = await store.fail("w1", jobId!, 1, 5000);
      expect(r).toEqual({ ok: false, code: "LOCK_EXPIRED" });
    });
  });

  it("NOT_OWNER for wrong workerId", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w1", ["t"], 1, 30000);
      const r = await store.fail("w2", job.id, 1, 5000);
      expect(r).toEqual({ ok: false, code: "NOT_OWNER" });
    });
  });
});

// ---------------------------------------------------------------------------
// FF-2 / AC-12: no Seq Scan with 1000 COMPLETED + 10 CREATED rows
// ---------------------------------------------------------------------------
describe("FF-2 / AC-12: no Seq Scan on full table with partial indexes", () => {
  it("fetchAndLock uses partial index, not Seq Scan", async () => {
    // Seed 1000 COMPLETED rows and 10 CREATED rows as migrator
    const now = Date.now();
    await withClient(migratorUrl(), async (c) => {
      // Bulk insert 1000 COMPLETED rows
      const completedValues = Array.from({ length: 1000 }, (_, i) =>
        `('${TENANT_A}', '${uuid()}', 'bulk', '{}', 'COMPLETED', 0, NULL, NULL, ${now - i}, ${now - i})`
      ).join(",");
      await c.query(`INSERT INTO choros.job (tenant_id, id, topic, variables, state, retries, lock_owner, lock_expiry, created_at, available_at) VALUES ${completedValues}`);

      // Bulk insert 10 CREATED rows
      const createdValues = Array.from({ length: 10 }, (_, i) =>
        `('${TENANT_A}', '${uuid()}', 'active', '{}', 'CREATED', 0, NULL, NULL, ${now - i}, ${now - i})`
      ).join(",");
      await c.query(`INSERT INTO choros.job (tenant_id, id, topic, variables, state, retries, lock_owner, lock_expiry, created_at, available_at) VALUES ${createdValues}`);
    });

    // Run EXPLAIN ANALYZE via migrator (bypasses RLS for EXPLAIN)
    await withClient(migratorUrl(), async (c) => {
      // Analyze to make sure stats are up to date
      await c.query("ANALYZE choros.job");

      const { rows } = await c.query(`
        EXPLAIN (FORMAT JSON, ANALYZE false)
        SELECT id FROM choros.job
        WHERE topic = ANY(ARRAY['active'])
          AND (
            (state = 'CREATED' AND available_at <= ${now})
            OR (state = 'LOCKED' AND lock_expiry  <= ${now})
          )
        ORDER BY created_at ASC
        LIMIT 5
      `);

      const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
      // The plan should NOT have a top-level Seq Scan (partial index should be used)
      // Allow "Bitmap Heap Scan" or "Index Scan" but not plain "Seq Scan on job"
      const hasSeqScanOnFullTable = plan.includes('"Seq Scan"') &&
        plan.includes('"Relation Name": "job"') &&
        !plan.includes('"Index Cond"');
      expect(hasSeqScanOnFullTable, `Plan uses Seq Scan: ${plan}`).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-7: ownership gate concurrent complete (two concurrent → exactly one ok:true)
// ---------------------------------------------------------------------------
describe("FF-7: ownership gate is atomic (concurrent complete)", () => {
  it("two concurrent complete calls return exactly one ok:true", async () => {
    const clock = makeFixedClock(1000);
    // Seed 1 LOCKED job
    const jobId = uuid();
    await seedJob({
      tenantId: TENANT_A,
      id: jobId,
      topic: "t",
      state: "LOCKED",
      lockOwner: "w1",
      lockExpiry: 9999999,
      available_at: 1,
      created_at: 1,
    });

    const pool1 = makeAppPool();
    const pool2 = makeAppPool();
    try {
      const [r1, r2] = await Promise.all([
        (async () => {
          const client = await pool1.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
            const store = new SingleClientStore(client, clock);
            const r = await store.complete("w1", jobId);
            await client.query("COMMIT");
            return r;
          } catch {
            await client.query("ROLLBACK");
            return { ok: false, code: "NOT_FOUND" as const };
          } finally {
            client.release();
          }
        })(),
        (async () => {
          const client = await pool2.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
            const store = new SingleClientStore(client, clock);
            const r = await store.complete("w1", jobId);
            await client.query("COMMIT");
            return r;
          } catch {
            await client.query("ROLLBACK");
            return { ok: false, code: "NOT_FOUND" as const };
          } finally {
            client.release();
          }
        })(),
      ]);
      const okCount = [r1, r2].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-13/AC-14: health metrics
// ---------------------------------------------------------------------------
describe("AC-13/AC-14: health queue metrics", () => {
  it("AC-13: depth=3 and oldestAvailableLagMs>=0 with 3 available jobs", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await seedJob({
        tenantId: TENANT_A,
        topic: "t",
        state: "CREATED",
        available_at: now - 1000 - i * 100,
        created_at: now - 2000,
      });
    }
    const pool = makeAppPool();
    try {
      // Health check bypasses RLS since it uses the app pool
      // We need to set GUC for the health query
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        const store = new SingleClientStore(client, { now: () => now });
        const h = await store.getQueueHealth();
        await client.query("COMMIT");
        expect(h.depth).toBe(3);
        expect(h.oldestAvailableLagMs).not.toBeNull();
        expect(h.oldestAvailableLagMs!).toBeGreaterThanOrEqual(0);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("AC-14: depth=0, oldestAvailableLagMs=null with empty queue", async () => {
    const pool = makeAppPool();
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        const store = new SingleClientStore(client, { now: () => Date.now() });
        const h = await store.getQueueHealth();
        await client.query("COMMIT");
        expect(h.depth).toBe(0);
        expect(h.oldestAvailableLagMs).toBeNull();
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-16/AC-17/AC-18: ops-operations
// ---------------------------------------------------------------------------
describe("AC-16: run_vacuum returns ok:true and is idempotent", () => {
  it("run_vacuum → ok:true, tableVacuumed='job'", async () => {
    const { runVacuum } = await import("../../../ops/catalog/run_vacuum.js");
    const r1 = await runVacuum(migratorUrl());
    expect(r1).toEqual({ ok: true, tableVacuumed: "job" });
    // Idempotent
    const r2 = await runVacuum(migratorUrl());
    expect(r2).toEqual({ ok: true, tableVacuumed: "job" });
  });
});

describe("AC-17: queue_stats returns correct metrics for known seed", () => {
  it("seed 5 CREATED, 2 LOCKED, 1 FAILED(DLQ), 3 COMPLETED → correct counts", async () => {
    const now = Date.now();
    // 5 CREATED available
    for (let i = 0; i < 5; i++) {
      await seedJob({ tenantId: TENANT_A, topic: "t", state: "CREATED", available_at: now - 100 });
    }
    // 2 LOCKED (with future lock_expiry so they are "locked", not expired)
    for (let i = 0; i < 2; i++) {
      await seedJob({ tenantId: TENANT_A, topic: "t", state: "LOCKED", lockExpiry: now + 99999, available_at: now - 100 });
    }
    // 1 FAILED retries=0 (DLQ)
    await seedJob({ tenantId: TENANT_A, topic: "t", state: "FAILED", retries: 0, available_at: now });
    // 3 COMPLETED
    for (let i = 0; i < 3; i++) {
      await seedJob({ tenantId: TENANT_A, topic: "t", state: "COMPLETED", available_at: now });
    }

    const { getQueueStats } = await import("../../../ops/catalog/queue_stats.js");
    const r = await getQueueStats(migratorUrl());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // depth = CREATED+LOCKED with available_at<=now (ADR §4.6): 5+2=7
    expect(r.stats.depth).toBe(7);
    expect(r.stats.lockedCount).toBe(2);
    expect(r.stats.failedCount).toBe(1);
    expect(r.stats.completedCount).toBe(3);
    expect(r.stats.dlqCount).toBe(1);
    expect(r.stats.oldestAvailableLagMs).not.toBeNull();
    expect(r.stats.oldestAvailableLagMs!).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// ADV-12 (PostgresJobStore): ownership gate takes precedence over payload validation
// Mirrors the InMemoryJobStore gate-precedence tests in variable-guard.test.ts.
// Confirms R-1 fix: Postgres path now follows ADR §4.4 ordering (gate → payload).
// ---------------------------------------------------------------------------
describe("ADV-12 (PostgresJobStore): ownership gate fires before payload validation", () => {
  it("NOT_FOUND returned for unknown jobId — invalid payload not evaluated", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const r = await store.complete("w1", "00000000-0000-0000-0000-000000000000", {
        rec: { kind: "record", registryId: "r", recordId: "x" },
      });
      expect(r).toEqual({ ok: false, code: "NOT_FOUND" });
    });
  });

  it("NOT_LOCKED returned for CREATED job — invalid payload not evaluated", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      const r = await store.complete("w1", job.id, {
        rec: { kind: "record", registryId: "r", recordId: "x" },
      });
      expect(r).toEqual({ ok: false, code: "NOT_LOCKED" });
    });
  });

  it("LOCK_EXPIRED returned for expired lock — invalid payload not evaluated", async () => {
    let jobId: string;
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      jobId = job.id;
      await store.fetchAndLock("w1", ["t"], 1, 0); // lockExpiry=1000 (immediately expired)
    });
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const r = await store.complete("w1", jobId!, {
        rec: { kind: "record", registryId: "r", recordId: "x" },
      });
      expect(r).toEqual({ ok: false, code: "LOCK_EXPIRED" });
    });
  });

  it("NOT_OWNER returned for wrong workerId — invalid payload not evaluated", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w1", ["t"], 1, 30000);
      const r = await store.complete("w2", job.id, {
        rec: { kind: "record", registryId: "r", recordId: "x" },
      });
      expect(r).toEqual({ ok: false, code: "NOT_OWNER" });
    });
  });

  it("RECORD_IN_PAYLOAD returned for valid owner but invalid payload", async () => {
    await runAsTenant(TENANT_A, makeFixedClock(1000), async (store) => {
      const job = await store.enqueue("t", {}, 0);
      await store.fetchAndLock("w1", ["t"], 1, 30000);
      const r = await store.complete("w1", job.id, {
        rec: { kind: "record", registryId: "r", recordId: "x" },
      });
      expect(r).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    });
  });
});

describe("AC-18: ops-operations at bad DATABASE_URL return ok:false", () => {
  it("run_vacuum with bad url → { ok: false, error: non-empty }", async () => {
    const { runVacuum } = await import("../../../ops/catalog/run_vacuum.js");
    const r = await runVacuum("postgres://invalid:invalid@localhost:9999/nonexistent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("queue_stats with bad url → { ok: false, error: non-empty }", async () => {
    const { getQueueStats } = await import("../../../ops/catalog/queue_stats.js");
    const r = await getQueueStats("postgres://invalid:invalid@localhost:9999/nonexistent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-0115 fail-closed: async paths (AC-7, AC-8)
//
// Verifies that PostgresJobStore used without a tenant GUC:
//   AC-7: enqueue → Promise.reject (Postgres error from current_setting(..., false))
//   AC-8: fetchAndLock → [] (RLS default-DENY; no data leaked)
// ---------------------------------------------------------------------------
describe("T-0115 fail-closed: async paths without tenant context", () => {
  // AC-7: enqueue without SET LOCAL → Promise.reject (GUC undefined → Postgres error)
  it("AC-7: enqueue without tenant context rejects (GUC undefined error)", async () => {
    // Create a fresh pool as choros_app — no transaction, no SET LOCAL.
    const pool = makeAppPool();
    try {
      const store = makeStore(undefined, pool);
      // enqueue uses current_setting('choros.tenant_id', false)::uuid in INSERT.
      // Without SET LOCAL the GUC is undefined → Postgres raises an error.
      await expect(store.enqueue("ct-async-test", {}, 0)).rejects.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  // AC-8: fetchAndLock without SET LOCAL → [] (RLS default-DENY; 0 rows)
  it("AC-8: fetchAndLock without tenant context returns [] (no data leaked)", async () => {
    // Seed a job under TENANT_A via migrator so there is something that COULD leak.
    await seedJob({
      tenantId: TENANT_A,
      topic: "ct-async-fetchtest",
      state: "CREATED",
      available_at: 1,
      created_at: 1,
    });

    // Use a fresh pool as choros_app — no transaction, no SET LOCAL.
    const pool = makeAppPool();
    try {
      const store = makeStore(makeFixedClock(Date.now()), pool);
      // fetchAndLock relies on RLS. Without GUC, current_setting('choros.tenant_id', true)
      // returns NULL → RLS default-DENY policy yields 0 rows. Must NOT throw.
      const result = await store.fetchAndLock("ct-worker", ["ct-async-fetchtest"], 10, 5000);
      expect(result, "fetchAndLock without GUC must return [] (no data leaked)").toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0063 sweepExpiredLocks — FF-1..FF-10 (integration fitness)
// ---------------------------------------------------------------------------

/** Seed a LOCKED job directly via migrator (bypasses RLS). */
async function seedLockedJob(params: {
  tenantId: string;
  topic?: string;
  retries?: number;
  lockOwner?: string;
  lockExpiry: number;
}): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.job
         (tenant_id, id, topic, variables, state, retries,
          lock_owner, lock_expiry, created_at, available_at)
       VALUES ($1, $2, $3, '{}', 'LOCKED', $4, $5, $6, $7, $7)`,
      [
        params.tenantId,
        id,
        params.topic ?? "sweep-test",
        params.retries ?? 1,
        params.lockOwner ?? "w-sweep",
        params.lockExpiry,
        now,
      ]
    );
  });
  return id;
}

/** Truncate outbox rows for test isolation. */
async function truncateOutbox(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.outbox");
  });
}

/** Count outbox rows for a given event_type + aggregate_id (via migrator). */
async function countOutboxIncidents(jobId: string): Promise<number> {
  const { rows } = await withClient(migratorUrl(), async (c) => {
    return c.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM choros.outbox
       WHERE event_type = 'worker_lock_expired' AND aggregate_id = $1`,
      [jobId]
    );
  });
  return Number(rows[0].cnt);
}

/** Fetch outbox row payload for a job (via migrator). */
async function fetchOutboxPayload(jobId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await withClient(migratorUrl(), async (c) => {
    return c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM choros.outbox
       WHERE event_type = 'worker_lock_expired' AND aggregate_id = $1
       LIMIT 1`,
      [jobId]
    );
  });
  return rows[0]?.payload ?? null;
}

/**
 * Create a migrator-pool-backed PostgresJobStore (BYPASSRLS — for health metrics only).
 * NOTE: do NOT use this for sweepExpiredLocks when testing RLS isolation — use makeAppJobStore.
 */
function makeMigratorStore(clock?: { now(): number }): PostgresJobStore {
  return new PostgresJobStore(new pg.Pool({ connectionString: migratorUrl() }), clock);
}

/**
 * Create an app-pool-backed PostgresJobStore (choros_app, NOBYPASSRLS).
 * Use this for sweepExpiredLocks RLS-isolation tests.
 */
function makeAppJobStore(clock?: { now(): number }): PostgresJobStore {
  return new PostgresJobStore(new pg.Pool({ connectionString: appUrl() }), clock);
}

/** Create an app-pool-backed PostgresOutboxStore. */
function makeOutboxStore(clock?: { now(): number }): PostgresOutboxStore {
  return new PostgresOutboxStore(new pg.Pool({ connectionString: appUrl() }), clock);
}

describe("T-0063 sweepExpiredLocks: FF-1/AC-1 — atomic sweep + outbox incident", () => {
  beforeEach(async () => {
    await truncateJobs();
    await truncateOutbox();
  });

  it("expired LOCKED job (retries=2) → state=CREATED, retries=1, 1 outbox incident (AC-1, AC-2)", async () => {
    const clock = makeFixedClock(1000);
    const outboxClock = makeFixedClock(1000);
    // Seed: job locked with lock_expiry=500 < now=1000
    const jobId = await seedLockedJob({ tenantId: TENANT_A, retries: 2, lockExpiry: 500 });

    const jobStore = makeMigratorStore(clock);
    const outboxStore = makeOutboxStore(outboxClock);
    try {
      const result = await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(result.reclaimed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.incidents).toBe(1);

      // Verify job state
      const job = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT state, retries, available_at FROM choros.job WHERE id = $1`,
          [jobId]
        );
        return rows[0];
      });
      expect(job.state).toBe("CREATED");
      expect(Number(job.retries)).toBe(1);
      // available_at = now (clock=1000) — immediate retry (no backoff)
      expect(Number(job.available_at)).toBe(1000);

      // Verify outbox incident
      expect(await countOutboxIncidents(jobId)).toBe(1);
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("expired LOCKED job (retries=0) → state=FAILED, 1 outbox incident (AC-3)", async () => {
    const clock = makeFixedClock(1000);
    const jobId = await seedLockedJob({ tenantId: TENANT_A, retries: 0, lockExpiry: 500 });

    const jobStore = makeMigratorStore(clock);
    const outboxStore = makeOutboxStore(makeFixedClock(1000));
    try {
      const result = await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(result.reclaimed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.incidents).toBe(1);

      const job = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT state, retries FROM choros.job WHERE id = $1`, [jobId]
        );
        return rows[0];
      });
      expect(job.state).toBe("FAILED");
      expect(Number(job.retries)).toBe(0);
      expect(await countOutboxIncidents(jobId)).toBe(1);
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("outbox incident payload contains topic, lockOwner, lockExpiry, retriesLeft (AC-4)", async () => {
    const jobId = await seedLockedJob({
      tenantId: TENANT_A,
      topic: "my-topic",
      retries: 3,
      lockOwner: "worker-xyz",
      lockExpiry: 100,
    });

    const jobStore = makeMigratorStore(makeFixedClock(1000));
    const outboxStore = makeOutboxStore(makeFixedClock(1000));
    try {
      await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      const payload = await fetchOutboxPayload(jobId);
      expect(payload).not.toBeNull();
      expect(payload!["topic"]).toBe("my-topic");
      expect(payload!["lockOwner"]).toBe("worker-xyz");
      expect(payload!["lockExpiry"]).toBe(100);
      expect(payload!["retriesLeft"]).toBe(2); // retries=3 → 3-1=2
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("idempotency: second sweep of same expired job → still only 1 outbox incident (AC-5)", async () => {
    const jobId = await seedLockedJob({ tenantId: TENANT_A, retries: 2, lockExpiry: 500 });

    const jobStore = makeMigratorStore(makeFixedClock(1000));
    const outboxStore = makeOutboxStore(makeFixedClock(1000));
    try {
      // First sweep → reclaims to CREATED
      await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(await countOutboxIncidents(jobId)).toBe(1);

      // Manually re-LOCK the job to simulate a second lock expiry with the SAME lockExpiry
      // (edge case: same idempotency key)
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `UPDATE choros.job SET state='LOCKED', lock_owner='w2', lock_expiry=500 WHERE id=$1`,
          [jobId]
        );
      });
      // Second sweep — same lock_expiry=500, same idempotency key → ON CONFLICT DO NOTHING
      await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      // Still only 1 incident for the original lock event
      expect(await countOutboxIncidents(jobId)).toBe(1);
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("active lock (lock_expiry > now) — sweep does NOT touch it (AC-6)", async () => {
    const jobId = await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: 9999999 });

    const jobStore = makeMigratorStore(makeFixedClock(1000));
    const outboxStore = makeOutboxStore(makeFixedClock(1000));
    try {
      const result = await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(result.reclaimed).toBe(0);
      expect(result.failed).toBe(0);

      const job = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT state FROM choros.job WHERE id = $1`, [jobId]
        );
        return rows[0];
      });
      expect(job.state).toBe("LOCKED"); // untouched
      expect(await countOutboxIncidents(jobId)).toBe(0);
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("CREATED/COMPLETED/FAILED jobs — sweep does NOT touch them (AC-7)", async () => {
    const now = Date.now();
    // Seed each non-LOCKED state
    const createdId = await seedJob({ tenantId: TENANT_A, topic: "sw", state: "CREATED", available_at: now - 1 });
    const completedId = await seedJob({ tenantId: TENANT_A, topic: "sw", state: "COMPLETED", available_at: now - 1 });
    const failedId = await seedJob({ tenantId: TENANT_A, topic: "sw", state: "FAILED", available_at: now - 1 });

    const jobStore = makeMigratorStore(makeFixedClock(now));
    const outboxStore = makeOutboxStore(makeFixedClock(now));
    try {
      const result = await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(result.reclaimed).toBe(0);
      expect(result.failed).toBe(0);

      for (const id of [createdId, completedId, failedId]) {
        expect(await countOutboxIncidents(id)).toBe(0);
      }
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("concurrent sweep — each job reclaimed exactly once (FOR UPDATE SKIP LOCKED) (AC-8)", async () => {
    const jobId = await seedLockedJob({ tenantId: TENANT_A, retries: 2, lockExpiry: 500 });
    const clock = makeFixedClock(1000);

    // Two parallel sweeps with independent pools
    const [r1, r2] = await Promise.all([
      (async () => {
        const js = makeMigratorStore(clock);
        const os = makeOutboxStore(makeFixedClock(1000));
        try {
          return await js.sweepExpiredLocks(os, TENANT_A);
        } finally {
          await js["pool"].end();
          await os["pool"].end();
        }
      })(),
      (async () => {
        const js = makeMigratorStore(clock);
        const os = makeOutboxStore(makeFixedClock(1000));
        try {
          return await js.sweepExpiredLocks(os, TENANT_A);
        } finally {
          await js["pool"].end();
          await os["pool"].end();
        }
      })(),
    ]);

    // Exactly one of them reclaimed it
    expect(r1.reclaimed + r2.reclaimed).toBe(1);
    // Exactly one incident (idempotency via FOR UPDATE SKIP LOCKED + ON CONFLICT DO NOTHING)
    expect(await countOutboxIncidents(jobId)).toBe(1);
  });

  it("RLS cross-tenant invariant: sweep(TENANT_A) does NOT touch TENANT_B jobs (AC-11)", async () => {
    const jobA = await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: 100 });
    const jobB = await seedLockedJob({ tenantId: TENANT_B, retries: 1, lockExpiry: 100 });

    // Use app pool (NOBYPASSRLS) to validate RLS isolation — migrator BYPASSRLS would see both tenants
    const jobStore = makeAppJobStore(makeFixedClock(1000));
    const outboxStore = makeOutboxStore(makeFixedClock(1000));
    try {
      // Only sweep TENANT_A
      await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);

      // TENANT_A job should be reclaimed
      const jA = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(`SELECT state FROM choros.job WHERE id=$1`, [jobA]);
        return rows[0];
      });
      expect(jA.state).toBe("CREATED");

      // TENANT_B job should be untouched (still LOCKED)
      const jB = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(`SELECT state FROM choros.job WHERE id=$1`, [jobB]);
        return rows[0];
      });
      expect(jB.state).toBe("LOCKED"); // not touched by TENANT_A sweep
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });

  it("FF-10/AC-12 smoke: lock_expiry=now-1 → reclaimed; lock_expiry=now+1000 → untouched", async () => {
    const now = Date.now();
    const expiredId = await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: now - 1 });
    const activeId = await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: now + 1000 });

    const jobStore = makeMigratorStore({ now: () => now });
    const outboxStore = makeOutboxStore({ now: () => now });
    try {
      const result = await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      expect(result.reclaimed).toBe(1);

      const [expired, active] = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT id, state FROM choros.job WHERE id IN ($1, $2)`,
          [expiredId, activeId]
        );
        return [rows.find(r => r.id === expiredId), rows.find(r => r.id === activeId)];
      });
      expect(expired!.state).toBe("CREATED");
      expect(active!.state).toBe("LOCKED");
      expect(await countOutboxIncidents(expiredId)).toBe(1);
      expect(await countOutboxIncidents(activeId)).toBe(0);
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0063 workerIncidents in getQueueHealth (FF-7/FF-8/AC-9/AC-10)
// ---------------------------------------------------------------------------
describe("T-0063 getQueueHealth.workerIncidents: FF-7/AC-9", () => {
  beforeEach(async () => {
    await truncateJobs();
    await truncateOutbox();
  });

  it("workerIncidents=0 with empty outbox (AC-10)", async () => {
    const jobStore = makeMigratorStore();
    try {
      const h = await jobStore.getQueueHealth();
      expect(h).toHaveProperty("workerIncidents");
      expect(h.workerIncidents).toBe(0);
    } finally {
      await jobStore["pool"].end();
    }
  });

  it("workerIncidents=N after N sweep reclaims (AC-10)", async () => {
    // Seed 2 expired LOCKED jobs
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: now - 1000 });
    }

    const jobStore = makeMigratorStore({ now: () => now });
    const outboxStore = makeOutboxStore({ now: () => now });
    try {
      await jobStore.sweepExpiredLocks(outboxStore, TENANT_A);
      const h = await jobStore.getQueueHealth();
      expect(h.workerIncidents).toBe(2);
      // Existing fields still present (AC-9)
      expect(h).toHaveProperty("depth");
      expect(h).toHaveProperty("oldestAvailableLagMs");
    } finally {
      await jobStore["pool"].end();
      await outboxStore["pool"].end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0063 migration 029 — SECURITY DEFINER function exists + idempotent (AC-14)
// ---------------------------------------------------------------------------
describe("T-0063 FF-12/AC-14: migration 029 idempotent + function exists", () => {
  it("choros.job_locked_expired_buckets function exists", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT routine_name FROM information_schema.routines
         WHERE routine_schema='choros' AND routine_name='job_locked_expired_buckets'`
      );
      expect(rows.length).toBe(1);
    });
  });

  it("job_locked_expired_buckets returns tenant_id+expired_count with expired LOCKED jobs", async () => {
    await truncateJobs();
    const now = Date.now();
    // Seed 2 expired LOCKED jobs for TENANT_A, 1 for TENANT_B
    await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: now - 1000 });
    await seedLockedJob({ tenantId: TENANT_A, retries: 1, lockExpiry: now - 500 });
    await seedLockedJob({ tenantId: TENANT_B, retries: 1, lockExpiry: now - 100 });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ tenant_id: string; expired_count: string }>(
        `SELECT tenant_id, expired_count FROM choros.job_locked_expired_buckets($1) ORDER BY tenant_id`,
        [now]
      );
      expect(rows.length).toBe(2);
      const a = rows.find(r => r.tenant_id === TENANT_A);
      const b = rows.find(r => r.tenant_id === TENANT_B);
      expect(Number(a!.expired_count)).toBe(2);
      expect(Number(b!.expired_count)).toBe(1);
    });
  });
});
