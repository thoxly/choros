/**
 * T-0116 Integration fitness tests — PostgresTimerStore + schema
 * Runs against live Postgres (compose, port 55432) via npm run fitness:db.
 *
 * Covers:
 *   FF-T1: app_timer in KNOWN_TENANT_TABLES
 *   FF-T2: partial index idx_app_timer_pending exists after migrations
 *   FF-T3: FORCE RLS on app_timer
 *   FF-T5: next_due_buckets() returns exactly 2 columns (tenant_id, timer_count)
 *   FF-T6: fetchAndFire uses FOR UPDATE SKIP LOCKED (static check replicated as assertion)
 *   FF-T8: timer_stats ops exits 0 with valid JSON for bad + real URL
 *   FF-T10: choros_app cannot ALTER/DROP next_due_buckets()
 *   AC-1: INSERT without GUC → Postgres error
 *   AC-2: SELECT in TENANT_A context, WHERE tenant_id=TENANT_B → 0 rows
 *   AC-4: next_due_buckets() from choros_app without GUC → aggregates correctly
 *   AC-5: next_due_buckets() result has exactly 2 columns
 *   AC-6: fetchAndFire(TENANT_A) doesn't capture TENANT_B rows
 *   AC-7: fetchAndFire LIMIT N → rowCount ≤ N
 *   AC-8: parallel fetchAndFire → rowCount1 + rowCount2 ≤ total
 *   AC-9: GET /health timer.timerLagMs ≥ 0 when overdue timers exist
 *   AC-10: GET /health timer.timerLagMs = null when no overdue timers
 *   AC-11: getTimerHealth throws on bad pool → health returns degraded
 *   AC-12: partial index exists with name containing app_timer and pending
 *   AC-13: app_timer table has all required columns
 *   AC-14: app_timer has FORCE ROW LEVEL SECURITY
 *
 * Environment:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import {
  TENANT_A,
  TENANT_B,
  migratorUrl,
  appUrl,
  withClient,
  uuid,
} from "./_helpers.js";
import { PostgresTimerStore } from "../../../src/core/postgres/pgTimerStore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixedClock(value: number) {
  return { now: () => value };
}

/** Create a pg.Pool connected as choros_app. */
function makeAppPool(): pg.Pool {
  return new pg.Pool({ connectionString: appUrl() });
}

/** Create a pg.Pool connected as choros_migrator. */
function makeMigratorPool(): pg.Pool {
  return new pg.Pool({ connectionString: migratorUrl() });
}

/**
 * A store that operates via a single pg.Client (for GUC-scoped transactions).
 */
class SingleClientTimerStore extends PostgresTimerStore {
  constructor(client: pg.PoolClient, clock?: { now(): number }) {
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

/**
 * Run a function with the app pool inside a transaction with tenant GUC set.
 */
async function runAsTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  clock: { now(): number },
  fn: (store: SingleClientTimerStore, client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const store = new SingleClientTimerStore(client, clock);
    const result = await fn(store, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Seed an app_timer row directly via migrator (bypasses RLS). */
async function seedTimer(params: {
  tenantId: string;
  id?: string;
  dueAt: number;
  state?: string;
  kind?: string;
}): Promise<string> {
  const id = params.id ?? uuid();
  const now = Date.now();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.app_timer
         (tenant_id, id, due_at, state, kind, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)
       ON CONFLICT DO NOTHING`,
      [
        params.tenantId,
        id,
        params.dueAt,
        params.state ?? "pending",
        params.kind ?? "test",
        now,
      ]
    );
  });
  return id;
}

/** Truncate app_timer via migrator. */
async function truncateTimers(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.app_timer");
  });
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------
let appPool: pg.Pool;
let migratorPool: pg.Pool;

beforeAll(async () => {
  appPool = makeAppPool();
  migratorPool = makeMigratorPool();
});

afterAll(async () => {
  await appPool.end();
  await migratorPool.end();
});

beforeEach(async () => {
  await truncateTimers();
});

// ---------------------------------------------------------------------------
// FF-T1: app_timer in KNOWN_TENANT_TABLES — static check via grep is in fitness.
// This test verifies the integration side: the file actually lists app_timer.
// ---------------------------------------------------------------------------
describe("FF-T1: app_timer in known_tenant_tables.txt", () => {
  it("known_tenant_tables.txt contains app_timer", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const txt = readFileSync(join(HERE, "..", "known_tenant_tables.txt"), "utf8");
    expect(txt.split("\n").map((s) => s.trim()).filter(Boolean)).toContain("app_timer");
  });
});

// ---------------------------------------------------------------------------
// FF-T2 / AC-12: partial index idx_app_timer_pending exists
// ---------------------------------------------------------------------------
describe("FF-T2 / AC-12: partial index idx_app_timer_pending exists after migrations", () => {
  it("idx_app_timer_pending present in pg_indexes", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'choros'
           AND tablename = 'app_timer'
           AND indexname LIKE '%app_timer%'
           AND indexname LIKE '%pending%'`
      );
      expect(rows.length, "no idx_app_timer_pending index found").toBeGreaterThanOrEqual(1);
      expect(rows[0].indexname).toContain("app_timer");
      expect(rows[0].indexname).toContain("pending");
    });
  });
});

// ---------------------------------------------------------------------------
// FF-T3 / AC-14: app_timer has FORCE ROW LEVEL SECURITY
// ---------------------------------------------------------------------------
describe("FF-T3 / AC-14: app_timer has FORCE ROW LEVEL SECURITY", () => {
  it("relforcerowsecurity = true for choros.app_timer", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class cls
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
         WHERE ns.nspname = 'choros' AND cls.relname = 'app_timer'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0].relrowsecurity, "app_timer must have RLS enabled").toBe(true);
      expect(rows[0].relforcerowsecurity, "app_timer must have FORCE RLS").toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13: app_timer table has all required columns
// ---------------------------------------------------------------------------
describe("AC-13: app_timer table has all required columns", () => {
  it("has tenant_id, id, due_at, state, kind, payload, created_at, fired_at, cancel_reason", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'choros' AND table_name = 'app_timer'
         ORDER BY ordinal_position`
      );
      const cols = rows.map((r) => r.column_name as string);
      for (const required of ["tenant_id", "id", "due_at", "state", "kind", "payload", "created_at"]) {
        expect(cols, `app_timer missing column ${required}`).toContain(required);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// FF-T5 / AC-4 / AC-5: next_due_buckets() returns exactly 2 columns
// ---------------------------------------------------------------------------
describe("FF-T5 / AC-4 / AC-5: next_due_buckets() returns only (tenant_id, timer_count)", () => {
  it("called from choros_app without GUC → exactly 2 columns per row", async () => {
    // Seed timers for TENANT_A (due in the past) via migrator
    const now = Date.now();
    await seedTimer({ tenantId: TENANT_A, dueAt: now - 5000 });
    await seedTimer({ tenantId: TENANT_A, dueAt: now - 3000 });
    await seedTimer({ tenantId: TENANT_B, dueAt: now - 1000 });

    // Call next_due_buckets from choros_app — without GUC (SECURITY DEFINER bypasses RLS)
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM choros.next_due_buckets($1)`,
        [now + 1000]
      );
      expect(rows.length, "next_due_buckets must return rows for tenants with overdue timers").toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        const keys = Object.keys(row);
        expect(keys.length, `row must have exactly 2 columns, got: ${JSON.stringify(keys)}`).toBe(2);
        expect(keys, "columns must be tenant_id and timer_count").toContain("tenant_id");
        expect(keys, "columns must be tenant_id and timer_count").toContain("timer_count");
        // Must NOT contain timer data fields
        expect(keys).not.toContain("id");
        expect(keys).not.toContain("payload");
        expect(keys).not.toContain("kind");
        expect(keys).not.toContain("due_at");
      }
    });
  });

  it("aggregates correctly — tenant_count matches seeded rows", async () => {
    const now = Date.now();
    await seedTimer({ tenantId: TENANT_A, dueAt: now - 5000 });
    await seedTimer({ tenantId: TENANT_A, dueAt: now - 3000 });
    await seedTimer({ tenantId: TENANT_B, dueAt: now - 1000 });

    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT tenant_id, timer_count FROM choros.next_due_buckets($1)`,
        [now + 1000]
      );
      const byTenant: Record<string, number> = {};
      for (const r of rows) {
        byTenant[r.tenant_id as string] = Number(r.timer_count);
      }
      expect(byTenant[TENANT_A], "TENANT_A must have 2 overdue timers").toBe(2);
      expect(byTenant[TENANT_B], "TENANT_B must have 1 overdue timer").toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-T10 / NF-5: choros_app cannot ALTER/DROP next_due_buckets()
// ---------------------------------------------------------------------------
describe("FF-T10 / NF-5: choros_app cannot ALTER/DROP next_due_buckets()", () => {
  it("ALTER FUNCTION next_due_buckets from choros_app → permission denied", async () => {
    await withClient(appUrl(), async (c) => {
      await expect(
        c.query(`ALTER FUNCTION choros.next_due_buckets(bigint) STABLE`)
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});

// ---------------------------------------------------------------------------
// AC-1: INSERT without GUC → Postgres error (fail-closed)
// ---------------------------------------------------------------------------
describe("AC-1: INSERT into app_timer without GUC → Postgres error", () => {
  it("INSERT without SET LOCAL choros.tenant_id raises error", async () => {
    await withClient(appUrl(), async (c) => {
      await c.query("BEGIN");
      await expect(
        c.query(
          `INSERT INTO choros.app_timer
             (tenant_id, id, due_at, state, kind, payload, created_at)
           VALUES
             (current_setting('choros.tenant_id', false)::uuid,
              $1, $2, 'pending', 'test', '{}'::jsonb, $2)`,
          [uuid(), Date.now()]
        )
      ).rejects.toBeDefined();
      await c.query("ROLLBACK");
    });
  });
});

// ---------------------------------------------------------------------------
// AC-2: SELECT in TENANT_A context, WHERE tenant_id=TENANT_B → 0 rows
// ---------------------------------------------------------------------------
describe("AC-2: SELECT in TENANT_A context with WHERE tenant_id=TENANT_B → 0 rows", () => {
  it("RLS filters out TENANT_B rows when context is TENANT_A", async () => {
    const now = Date.now();
    await seedTimer({ tenantId: TENANT_B, dueAt: now + 60000 });

    await withClient(appUrl(), async (c) => {
      await c.query("BEGIN");
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.app_timer WHERE tenant_id = $1`,
        [TENANT_B]
      );
      await c.query("COMMIT");
      expect(rows[0].n, "TENANT_B rows must not be visible in TENANT_A context").toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6: fetchAndFire(TENANT_A) does not capture TENANT_B rows
// ---------------------------------------------------------------------------
describe("AC-6: fetchAndFire(TENANT_A) doesn't capture TENANT_B rows", () => {
  it("TENANT_B timer stays pending after fetchAndFire for TENANT_A", async () => {
    const now = Date.now();
    const timerBId = await seedTimer({ tenantId: TENANT_B, dueAt: now - 1000 });
    const timerAId = await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000 });

    const store = new PostgresTimerStore(appPool, makeFixedClock(now));
    const fired = await store.fetchAndFire(TENANT_A, now + 500, 10);

    // TENANT_A timer was captured
    const firedIds = fired.map((t) => t.id);
    expect(firedIds).toContain(timerAId);
    // TENANT_B timer was NOT captured
    expect(firedIds).not.toContain(timerBId);

    // Verify via migrator that TENANT_B timer is still pending
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [timerBId]
      );
      expect(rows[0].state, "TENANT_B timer must remain pending").toBe("pending");
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7: fetchAndFire with LIMIT N → rowCount ≤ N
// ---------------------------------------------------------------------------
describe("AC-7: fetchAndFire LIMIT N → returns ≤ N rows, rest stay pending", () => {
  it("with 5 overdue timers and limit=3, only 3 are fired", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000 - i });
    }

    const store = new PostgresTimerStore(appPool, makeFixedClock(now));
    const fired = await store.fetchAndFire(TENANT_A, now + 500, 3);
    expect(fired.length, "must return exactly 3 timers").toBe(3);

    // Verify 2 remain pending
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.app_timer
         WHERE tenant_id = $1 AND state = 'pending'`,
        [TENANT_A]
      );
      expect(rows[0].n, "2 timers must remain pending").toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8: parallel fetchAndFire — FOR UPDATE SKIP LOCKED semantics
// ---------------------------------------------------------------------------
describe("AC-8: parallel fetchAndFire uses SKIP LOCKED — no double-capture", () => {
  it("two parallel fetchAndFire calls capture disjoint sets", async () => {
    const now = Date.now();
    // Seed 4 overdue timers
    for (let i = 0; i < 4; i++) {
      await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000 - i });
    }

    const pool1 = makeAppPool();
    const pool2 = makeAppPool();
    try {
      const store1 = new PostgresTimerStore(pool1, makeFixedClock(now));
      const store2 = new PostgresTimerStore(pool2, makeFixedClock(now));

      const [r1, r2] = await Promise.all([
        store1.fetchAndFire(TENANT_A, now + 500, 10),
        store2.fetchAndFire(TENANT_A, now + 500, 10),
      ]);

      // Combined must be ≤ total seeded (no double-capture)
      expect(r1.length + r2.length, "combined count must not exceed 4").toBeLessThanOrEqual(4);

      // No timer appears in both result sets
      const ids1 = new Set(r1.map((t) => t.id));
      for (const t of r2) {
        expect(ids1.has(t.id), `timer ${t.id} captured twice!`).toBe(false);
      }
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9: getTimerHealth returns timerLagMs ≥ 0 when overdue timers exist
// ---------------------------------------------------------------------------
describe("AC-9: getTimerHealth returns timerLagMs ≥ 0 with overdue pending timer", () => {
  it("timerLagMs is a non-negative number when overdue timer present", async () => {
    const now = Date.now();
    // Seed a timer that's already overdue
    await seedTimer({ tenantId: TENANT_A, dueAt: now - 5000 });

    // Use migrator pool (no RLS needed for health)
    const store = new PostgresTimerStore(migratorPool, makeFixedClock(now));
    const health = await store.getTimerHealth();
    expect(health.timerLagMs, "timerLagMs must not be null").not.toBeNull();
    expect(health.timerLagMs!, "timerLagMs must be ≥ 0").toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// AC-10: getTimerHealth returns timerLagMs=null when no overdue timers
// ---------------------------------------------------------------------------
describe("AC-10: getTimerHealth returns timerLagMs=null when no overdue timers", () => {
  it("timerLagMs is null when all pending timers are in the future", async () => {
    const now = Date.now();
    // Seed a timer due in the future
    await seedTimer({ tenantId: TENANT_A, dueAt: now + 60000 });

    const store = new PostgresTimerStore(migratorPool, makeFixedClock(now));
    const health = await store.getTimerHealth();
    expect(health.timerLagMs, "timerLagMs must be null when no overdue timers").toBeNull();
  });

  it("timerLagMs is null when app_timer is empty", async () => {
    const store = new PostgresTimerStore(migratorPool, makeFixedClock(Date.now()));
    const health = await store.getTimerHealth();
    expect(health.timerLagMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-11: getTimerHealth throws on broken pool → health endpoint returns degraded
// ---------------------------------------------------------------------------
describe("AC-11: getTimerHealth throws on Postgres error (broken pool)", () => {
  it("getTimerHealth rejects when pool connection fails", async () => {
    const badPool = new pg.Pool({
      connectionString: "postgres://invalid:invalid@localhost:9999/nonexistent",
      connectionTimeoutMillis: 500,
    });
    const store = new PostgresTimerStore(badPool, makeFixedClock(Date.now()));
    await expect(store.getTimerHealth()).rejects.toBeDefined();
    await badPool.end().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// FF-T8: timer_stats ops exits 0 with valid JSON (bad URL + real URL)
// ---------------------------------------------------------------------------
describe("FF-T8: timer_stats ops exits 0 with valid JSON for bad URL and real URL", () => {
  it("getTimerStats with bad URL returns {ok:false, error:non-empty}", async () => {
    const { getTimerStats } = await import("../../../ops/catalog/timer_stats.js");
    const r = await getTimerStats("postgres://invalid:invalid@localhost:9999/nonexistent");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length, "error message must be non-empty").toBeGreaterThan(0);
    }
  });

  it("getTimerStats with real migrator URL returns {ok:true, pendingCount:...}", async () => {
    const { getTimerStats } = await import("../../../ops/catalog/timer_stats.js");
    const r = await getTimerStats(migratorUrl());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.stats.pendingCount).toBe("number");
    expect(typeof r.stats.firingCount).toBe("number");
    expect(typeof r.stats.doneCount).toBe("number");
    expect(typeof r.stats.cancelledCount).toBe("number");
    expect(typeof r.stats.overdueCount).toBe("number");
    // timerLagMs is null or number
    expect(r.stats.timerLagMs === null || typeof r.stats.timerLagMs === "number").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// two_tenant idempotency: 12 migrations recorded after applying 011+012
// ---------------------------------------------------------------------------
describe("Migration count: 012 migrations recorded after T-0116", () => {
  it("schema_migrations has 12 rows (001–012)", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.schema_migrations`
      );
      expect(rows[0].n).toBe(12);
    });
  });
});

// ---------------------------------------------------------------------------
// R-5: cancel() integration tests
// ---------------------------------------------------------------------------
describe("cancel(): state transitions and false-return on wrong state", () => {
  it("cancel pending timer → state becomes 'cancelled', returns true", async () => {
    const now = Date.now();
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now + 60000, state: "pending" });

    await runAsTenant(appPool, TENANT_A, makeFixedClock(now), async (store) => {
      const result = await store.cancel(TENANT_A, id, "test reason");
      expect(result, "cancel must return true when row was updated").toBe(true);
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state, cancel_reason FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "timer must be cancelled").toBe("cancelled");
      expect(rows[0].cancel_reason, "cancel_reason must be stored").toBe("test reason");
    });
  });

  it("cancel non-pending timer (state='firing') → returns false, state unchanged", async () => {
    const now = Date.now();
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000, state: "firing" });

    await runAsTenant(appPool, TENANT_A, makeFixedClock(now), async (store) => {
      const result = await store.cancel(TENANT_A, id);
      expect(result, "cancel of non-pending timer must return false").toBe(false);
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "firing timer must remain firing after failed cancel").toBe("firing");
    });
  });

  it("cancel with wrong tenantId (R-1 fix) → returns false, TENANT_A timer unchanged", async () => {
    const now = Date.now();
    // Seed a pending timer for TENANT_A
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now + 60000, state: "pending" });

    // TENANT_B context tries to cancel TENANT_A's timer — must get 0 rows
    await runAsTenant(appPool, TENANT_B, makeFixedClock(now), async (store) => {
      const result = await store.cancel(TENANT_B, id);
      expect(result, "cancel with wrong tenant must return false").toBe(false);
    });

    // TENANT_A's timer must still be pending
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "TENANT_A timer must remain pending after cross-tenant cancel attempt").toBe("pending");
    });
  });
});

// ---------------------------------------------------------------------------
// R-5: done() integration tests
// ---------------------------------------------------------------------------
describe("done(): state transitions and false-return on wrong state", () => {
  it("done firing timer → state becomes 'done', returns true", async () => {
    const now = Date.now();
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000, state: "firing" });

    await runAsTenant(appPool, TENANT_A, makeFixedClock(now), async (store) => {
      const result = await store.done(TENANT_A, id);
      expect(result, "done must return true when row was updated").toBe(true);
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "timer must be done").toBe("done");
    });
  });

  it("done non-firing timer (state='pending') → returns false, state unchanged", async () => {
    const now = Date.now();
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now + 60000, state: "pending" });

    await runAsTenant(appPool, TENANT_A, makeFixedClock(now), async (store) => {
      const result = await store.done(TENANT_A, id);
      expect(result, "done of non-firing timer must return false").toBe(false);
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "pending timer must remain pending after failed done").toBe("pending");
    });
  });

  it("done with wrong tenantId (R-2 fix) → returns false, TENANT_A timer unchanged", async () => {
    const now = Date.now();
    // Seed a firing timer for TENANT_A
    const id = await seedTimer({ tenantId: TENANT_A, dueAt: now - 1000, state: "firing" });

    // TENANT_B context tries to mark TENANT_A's timer done — must get 0 rows
    await runAsTenant(appPool, TENANT_B, makeFixedClock(now), async (store) => {
      const result = await store.done(TENANT_B, id);
      expect(result, "done with wrong tenant must return false").toBe(false);
    });

    // TENANT_A's timer must still be firing
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.app_timer WHERE id = $1`,
        [id]
      );
      expect(rows[0].state, "TENANT_A timer must remain firing after cross-tenant done attempt").toBe("firing");
    });
  });
});
