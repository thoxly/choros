/**
 * T-0062 Integration fitness tests — idempotency + outbox.
 * Runs against live Postgres (compose) via npm run fitness:db.
 *
 * Covers:
 *   FF-1  / AC-4:  partial-unique job_idempotency_key_uq exists (tenant_id leading, NOT NULL pred)
 *   FF-2  / AC-7:  outbox in known_tenant_tables.txt + table exists
 *   FF-5  / AC-15: idx_outbox_pending partial index; EXPLAIN phase-2 = Index Scan, not Seq Scan
 *   FF-6  / AC-9/AC-10: outbox_pending_buckets() = exactly 2 columns, no GUC
 *   FF-8  / AC-13/AC-14: dispatched_at_iff CHECK; state machine markDispatched/markRetry/dead
 *   AC-1/AC-2/AC-3: enqueue idempotency-key (new / repeat-dedup / undefined = new)
 *   AC-5:  outbox INSERT without GUC → fail-closed (Postgres error)
 *   AC-6:  cross-tenant SELECT outbox → 0 TENANT_B rows in TENANT_A context
 *   AC-8:  enqueueInTx + domain mutation rolled back together → no row persists
 *   AC-11: claimBatch(TENANT_A) doesn't capture TENANT_B rows
 *   AC-12: parallel claimBatch → FOR UPDATE SKIP LOCKED, disjoint sets
 *   AC-16: getOutboxHealth pendingLagMs/deadCount; broken pool → throws (degraded)
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
import { PostgresOutboxStore } from "../../../src/core/postgres/pgOutboxStore.js";
import { PostgresJobStore } from "../../../src/core/postgres/pgJobStore.js";
import type { OutboxInsert } from "../../../src/core/outboxTypes.js";

function makeFixedClock(value: number) {
  return { now: () => value };
}

function makeAppPool(): pg.Pool {
  return new pg.Pool({ connectionString: appUrl() });
}
function makeMigratorPool(): pg.Pool {
  return new pg.Pool({ connectionString: migratorUrl() });
}

/** Seed an outbox row directly via migrator (bypasses RLS). */
async function seedOutbox(params: {
  tenantId: string;
  id?: string;
  state?: string;
  availableAt?: number;
  attempts?: number;
  /** T-0644: override eventType/payload (default 'evt' / {} for pre-existing ACs). */
  eventType?: string;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const id = params.id ?? uuid();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.outbox
         (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
          state, idempotency_key, attempts, created_at, available_at,
          dispatched_at)
       VALUES ($1, $2, 'test', $3, $8, $9::jsonb,
               $4, $5, $6, 0, $7,
               CASE WHEN $4 = 'dispatched' THEN 0 ELSE NULL END)
       ON CONFLICT DO NOTHING`,
      [
        params.tenantId,
        id,
        uuid(),
        params.state ?? "pending",
        `idk-${id}`,
        params.attempts ?? 0,
        params.availableAt ?? 0,
        params.eventType ?? "evt",
        JSON.stringify(params.payload ?? {}),
      ]
    );
  });
  return id;
}

/** Read back a single outbox row's state/attempts by id (migrator, no RLS). */
async function readOutboxRow(
  id: string
): Promise<{ state: string; attempts: number; last_error: string | null } | undefined> {
  let found: { state: string; attempts: number; last_error: string | null } | undefined;
  await withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query<{ state: string; attempts: number; last_error: string | null }>(
      `SELECT state, attempts, last_error FROM choros.outbox WHERE id = $1`,
      [id]
    );
    found = rows[0];
  });
  return found;
}

async function truncateOutbox(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.outbox");
  });
}

/** Run an outbox-store operation as a tenant inside its own transaction. */
async function runAsTenant<T>(
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
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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
  await truncateOutbox();
});

// ---------------------------------------------------------------------------
// FF-1 / AC-4: partial-unique job_idempotency_key_uq
// ---------------------------------------------------------------------------
describe("FF-1 / AC-4: job_idempotency_key_uq partial-unique exists", () => {
  it("index exists, is unique, partial (NOT NULL pred), tenant_id leading", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT i.indisunique, i.indpred IS NOT NULL AS is_partial,
                a.attname AS first_col
         FROM pg_index i
         JOIN pg_class cls ON cls.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE ns.nspname = 'choros' AND cls.relname = 'job_idempotency_key_uq'`
      );
      expect(rows.length, "job_idempotency_key_uq must exist").toBe(1);
      expect(rows[0].indisunique, "must be UNIQUE").toBe(true);
      expect(rows[0].is_partial, "must be partial (indpred NOT NULL)").toBe(true);
      expect(rows[0].first_col, "tenant_id must lead (FF-LEAD)").toBe("tenant_id");
    });
  });
});

// ---------------------------------------------------------------------------
// FF-2 / AC-7: outbox in registry + table exists
// ---------------------------------------------------------------------------
describe("FF-2 / AC-7: outbox registered and present", () => {
  it("known_tenant_tables.txt contains outbox", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const txt = readFileSync(join(HERE, "..", "known_tenant_tables.txt"), "utf8");
    expect(txt.split("\n").map((s) => s.trim()).filter(Boolean)).toContain("outbox");
  });

  it("choros.outbox table exists with FORCE RLS", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class cls
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
         WHERE ns.nspname = 'choros' AND cls.relname = 'outbox'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-8: dispatched_at_iff CHECK exists and rejects dispatched without dispatched_at
// ---------------------------------------------------------------------------
describe("FF-8: outbox_dispatched_at_iff CHECK", () => {
  it("constraint exists", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'outbox_dispatched_at_iff'`
      );
      expect(rows.length).toBe(1);
    });
  });

  it("INSERT state='dispatched' WITHOUT dispatched_at → CHECK violation (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await expect(
        c.query(
          `INSERT INTO choros.outbox
             (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
              state, idempotency_key, attempts, created_at, available_at, dispatched_at)
           VALUES ($1, $2, 't', $3, 'e', '{}'::jsonb,
                   'dispatched', $4, 0, 0, 0, NULL)`,
          [TENANT_A, uuid(), uuid(), `idk-${uuid()}`]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-9 / AC-10: outbox_pending_buckets — exactly 2 columns, no GUC
// ---------------------------------------------------------------------------
describe("FF-6 / AC-9 / AC-10: outbox_pending_buckets() = 2 columns, no GUC", () => {
  it("called from choros_app without GUC → exactly (tenant_id, pending_count)", async () => {
    await seedOutbox({ tenantId: TENANT_A, availableAt: 0 });
    await seedOutbox({ tenantId: TENANT_A, availableAt: 0 });
    await seedOutbox({ tenantId: TENANT_B, availableAt: 0 });

    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM choros.outbox_pending_buckets($1)`,
        [1000]
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        const keys = Object.keys(row);
        expect(keys.length, JSON.stringify(keys)).toBe(2);
        expect(keys).toContain("tenant_id");
        expect(keys).toContain("pending_count");
        expect(keys).not.toContain("payload");
        expect(keys).not.toContain("id");
      }
      const byTenant: Record<string, number> = {};
      for (const r of rows) byTenant[r.tenant_id as string] = Number(r.pending_count);
      expect(byTenant[TENANT_A]).toBe(2);
      expect(byTenant[TENANT_B]).toBe(1);
    });
  });

  it("store.pendingBuckets wraps the function", async () => {
    await seedOutbox({ tenantId: TENANT_A, availableAt: 0 });
    const store = new PostgresOutboxStore(appPool, makeFixedClock(1000));
    const buckets = await store.pendingBuckets(1000);
    const a = buckets.find((b) => b.tenantId === TENANT_A);
    expect(a?.pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FF-5 / AC-15: idx_outbox_pending — EXPLAIN phase-2 = Index Scan, not Seq Scan
// ---------------------------------------------------------------------------
describe("FF-5 / AC-15: idx_outbox_pending partial index + EXPLAIN no Seq Scan", () => {
  it("index exists with name containing outbox and pending", async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'choros' AND tablename = 'outbox'
           AND indexname LIKE '%outbox%' AND indexname LIKE '%pending%'`
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("EXPLAIN of phase-2 candidate select with 1000 dispatched + 10 pending → uses index, no full Seq Scan", async () => {
    // Seed 1000 dispatched + 10 pending for TENANT_A.
    //
    // T-0646: this was previously 1010 sequential single-row INSERT round-trips
    // on one connection — pure test-fixture seeding (no store/product function
    // in the loop), so it is safe to collapse into one multi-row INSERT per
    // state via unnest() without touching any production code path. Same
    // columns, same values, same row count — only the round-trip count changes
    // (was right on the vitest 5000ms default testTimeout boundary; T-0646 brief).
    await withClient(migratorUrl(), async (c) => {
      await c.query("BEGIN");
      const dispatchedIds = Array.from({ length: 1000 }, () => uuid());
      const dispatchedAggIds = Array.from({ length: 1000 }, () => uuid());
      const dispatchedIdks = dispatchedIds.map((id, i) => `idk-d-${i}-${id}`);
      await c.query(
        `INSERT INTO choros.outbox
           (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
            state, idempotency_key, attempts, created_at, available_at, dispatched_at)
         SELECT $1, x.id, 't', x.aggregate_id, 'e', '{}'::jsonb,
                'dispatched', x.idempotency_key, 0, 0, 0, 0
           FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS x(id, aggregate_id, idempotency_key)`,
        [TENANT_A, dispatchedIds, dispatchedAggIds, dispatchedIdks]
      );
      const pendingIds = Array.from({ length: 10 }, () => uuid());
      const pendingAggIds = Array.from({ length: 10 }, () => uuid());
      const pendingIdks = pendingIds.map((id, i) => `idk-p-${i}-${id}`);
      await c.query(
        `INSERT INTO choros.outbox
           (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
            state, idempotency_key, attempts, created_at, available_at)
         SELECT $1, x.id, 't', x.aggregate_id, 'e', '{}'::jsonb,
                'pending', x.idempotency_key, 0, 0, 0
           FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS x(id, aggregate_id, idempotency_key)`,
        [TENANT_A, pendingIds, pendingAggIds, pendingIdks]
      );
      await c.query("COMMIT");
      await c.query("ANALYZE choros.outbox");
    });

    await withClient(appUrl(), async (c) => {
      await c.query("BEGIN");
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `EXPLAIN
         SELECT id FROM choros.outbox
         WHERE state = 'pending' AND available_at <= $1
         ORDER BY available_at ASC, created_at ASC
         LIMIT 10`,
        [1000]
      );
      await c.query("COMMIT");
      const plan = rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      // The partial index must be used; there must be no full sequential scan of outbox.
      expect(plan, plan).toContain("idx_outbox_pending");
      expect(plan, plan).not.toMatch(/Seq Scan on outbox/);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: outbox INSERT without GUC → fail-closed
// ---------------------------------------------------------------------------
describe("AC-5: enqueueInTx / INSERT without GUC → Postgres error (fail-closed)", () => {
  it("INSERT via current_setting(false) without SET LOCAL raises", async () => {
    await withClient(appUrl(), async (c) => {
      await c.query("BEGIN");
      await expect(
        c.query(
          `INSERT INTO choros.outbox
             (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
              idempotency_key, created_at, available_at)
           VALUES
             (current_setting('choros.tenant_id', false)::uuid,
              $1, 't', $2, 'e', '{}'::jsonb, $3, 0, 0)`,
          [uuid(), uuid(), `idk-${uuid()}`]
        )
      ).rejects.toBeDefined();
      await c.query("ROLLBACK");
    });
  });

  it("store.enqueueInTx without GUC → throws", async () => {
    const store = new PostgresOutboxStore(appPool, makeFixedClock(0));
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const row: OutboxInsert = {
        aggregateKind: "t",
        aggregateId: uuid(),
        eventType: "e",
        payload: {},
        idempotencyKey: `idk-${uuid()}`,
      };
      await expect(store.enqueueInTx(client, row)).rejects.toBeDefined();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: cross-tenant SELECT outbox → 0 TENANT_B rows
// ---------------------------------------------------------------------------
describe("AC-6: cross-tenant SELECT outbox → 0 rows", () => {
  it("TENANT_A context sees no TENANT_B outbox rows", async () => {
    await seedOutbox({ tenantId: TENANT_B });
    await withClient(appUrl(), async (c) => {
      await c.query("BEGIN");
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.outbox WHERE tenant_id = $1`,
        [TENANT_B]
      );
      await c.query("COMMIT");
      expect(rows[0].n).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8: enqueueInTx + domain mutation rolled back together (atomicity)
// ---------------------------------------------------------------------------
describe("AC-8: enqueueInTx atomic with domain mutation (rollback → neither persists)", () => {
  it("a rolled-back tx leaves no outbox row and no domain row", async () => {
    const store = new PostgresOutboxStore(appPool, makeFixedClock(0));
    const jobId = uuid();
    const outboxKey = `idk-atomic-${uuid()}`;

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      // Domain mutation: insert a job.
      await client.query(
        `INSERT INTO choros.job
           (tenant_id, id, topic, variables, state, retries,
            lock_owner, lock_expiry, created_at, available_at)
         VALUES (current_setting('choros.tenant_id', false)::uuid,
                 $1, 'atomic-test', '{}'::jsonb, 'CREATED', 0, NULL, NULL, 0, 0)`,
        [jobId]
      );
      // Outbox insert in the SAME tx (same client).
      await store.enqueueInTx(client, {
        aggregateKind: "job",
        aggregateId: jobId,
        eventType: "job_created",
        payload: { jobId },
        idempotencyKey: outboxKey,
      });
      // Roll back the whole transaction.
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Neither the job nor the outbox row may exist.
    await withClient(migratorUrl(), async (c) => {
      const job = await c.query(`SELECT 1 FROM choros.job WHERE id = $1`, [jobId]);
      expect(job.rows.length, "job must not persist after rollback").toBe(0);
      const out = await c.query(
        `SELECT 1 FROM choros.outbox WHERE idempotency_key = $1`,
        [outboxKey]
      );
      expect(out.rows.length, "outbox row must not persist after rollback").toBe(0);
    });
  });

  it("a committed tx persists both", async () => {
    const store = new PostgresOutboxStore(appPool, makeFixedClock(0));
    const jobId = uuid();
    const outboxKey = `idk-commit-${uuid()}`;
    await runAsTenant(appPool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO choros.job
           (tenant_id, id, topic, variables, state, retries,
            lock_owner, lock_expiry, created_at, available_at)
         VALUES (current_setting('choros.tenant_id', false)::uuid,
                 $1, 'atomic-test', '{}'::jsonb, 'CREATED', 0, NULL, NULL, 0, 8640000000000)`,
        [jobId]
      );
      await store.enqueueInTx(client, {
        aggregateKind: "job",
        aggregateId: jobId,
        eventType: "job_created",
        payload: { jobId },
        idempotencyKey: outboxKey,
      });
    });
    await withClient(migratorUrl(), async (c) => {
      const out = await c.query(
        `SELECT state FROM choros.outbox WHERE idempotency_key = $1`,
        [outboxKey]
      );
      expect(out.rows.length).toBe(1);
      expect(out.rows[0].state).toBe("pending");
      // cleanup the job
      await c.query(`DELETE FROM choros.job WHERE id = $1`, [jobId]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11: claimBatch(TENANT_A) doesn't capture TENANT_B rows
// ---------------------------------------------------------------------------
describe("AC-11: claimBatch per-tenant — TENANT_B rows stay pending", () => {
  it("claimBatch(TENANT_A) captures only TENANT_A rows", async () => {
    const idA = await seedOutbox({ tenantId: TENANT_A, availableAt: 0 });
    const idB = await seedOutbox({ tenantId: TENANT_B, availableAt: 0 });

    const store = new PostgresOutboxStore(appPool, makeFixedClock(1000));
    const claimed = await store.claimBatch(TENANT_A, 10);
    const ids = claimed.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state FROM choros.outbox WHERE id = $1`,
        [idB]
      );
      expect(rows[0].state, "TENANT_B row must stay pending").toBe("pending");
    });
  });

  it("claimBatch rejects a non-UUID tenantId (R-3)", async () => {
    const store = new PostgresOutboxStore(appPool, makeFixedClock(0));
    await expect(store.claimBatch("not-a-uuid; DROP TABLE", 10)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-12: parallel claimBatch — FOR UPDATE SKIP LOCKED, disjoint sets
// ---------------------------------------------------------------------------
describe("AC-12: parallel claimBatch uses SKIP LOCKED — no double-claim", () => {
  it("two parallel claimBatch calls capture disjoint sets", async () => {
    for (let i = 0; i < 4; i++) {
      await seedOutbox({ tenantId: TENANT_A, availableAt: 0 });
    }
    const pool1 = makeAppPool();
    const pool2 = makeAppPool();
    try {
      const s1 = new PostgresOutboxStore(pool1, makeFixedClock(1000));
      const s2 = new PostgresOutboxStore(pool2, makeFixedClock(1000));
      const [r1, r2] = await Promise.all([
        s1.claimBatch(TENANT_A, 10),
        s2.claimBatch(TENANT_A, 10),
      ]);
      expect(r1.length + r2.length, "combined ≤ 4").toBeLessThanOrEqual(4);
      const ids1 = new Set(r1.map((r) => r.id));
      for (const r of r2) {
        expect(ids1.has(r.id), `row ${r.id} claimed twice`).toBe(false);
      }
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-13 / AC-14 / FF-8: state machine — markDispatched, markRetry, dead, monotonicity
// ---------------------------------------------------------------------------
describe("AC-13 / AC-14: state machine markDispatched / markRetry / dead", () => {
  it("markDispatched: dispatching → dispatched + dispatched_at", async () => {
    const id = await seedOutbox({ tenantId: TENANT_A, state: "dispatching" });
    const ok = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresOutboxStore(singleClientPool(client), makeFixedClock(777));
      return store.markDispatched(TENANT_A, id);
    });
    expect(ok).toBe(true);
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state, dispatched_at FROM choros.outbox WHERE id = $1`,
        [id]
      );
      expect(rows[0].state).toBe("dispatched");
      expect(Number(rows[0].dispatched_at)).toBe(777);
    });
  });

  it("markDispatched on a non-dispatching row → false (no-op, monotonic)", async () => {
    const id = await seedOutbox({ tenantId: TENANT_A, state: "pending" });
    const ok = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresOutboxStore(singleClientPool(client), makeFixedClock(1));
      return store.markDispatched(TENANT_A, id);
    });
    expect(ok).toBe(false);
  });

  it("markRetry: dispatching → pending, attempts+1, available_at=now+backoff", async () => {
    const id = await seedOutbox({ tenantId: TENANT_A, state: "dispatching", attempts: 0 });
    const outcome = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresOutboxStore(singleClientPool(client), makeFixedClock(100));
      return store.markRetry(TENANT_A, id, 5000, "boom", 3);
    });
    expect(outcome).toBe("pending");
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT state, attempts, available_at, last_error FROM choros.outbox WHERE id = $1`,
        [id]
      );
      expect(rows[0].state).toBe("pending");
      expect(Number(rows[0].attempts)).toBe(1);
      expect(Number(rows[0].available_at)).toBe(5100);
      expect(rows[0].last_error).toBe("boom");
    });
  });

  it("markRetry at last attempt → dead (AC-14); dead row not re-claimed", async () => {
    // attempts=2, maxAttempts=3 → attempts+1=3 >= 3 → dead.
    const id = await seedOutbox({ tenantId: TENANT_A, state: "dispatching", attempts: 2 });
    const outcome = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresOutboxStore(singleClientPool(client), makeFixedClock(100));
      return store.markRetry(TENANT_A, id, 5000, "final", 3);
    });
    expect(outcome).toBe("dead");
    // dead row must not be claimable.
    const store2 = new PostgresOutboxStore(appPool, makeFixedClock(1_000_000));
    const claimed = await store2.claimBatch(TENANT_A, 10);
    expect(claimed.map((r) => r.id)).not.toContain(id);
  });

  it("markRetry on a non-dispatching row → noop (monotonic; no decrement path)", async () => {
    const id = await seedOutbox({ tenantId: TENANT_A, state: "dispatched", attempts: 0 });
    const outcome = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresOutboxStore(singleClientPool(client), makeFixedClock(1));
      return store.markRetry(TENANT_A, id, 5000, "x", 3);
    });
    expect(outcome).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3: enqueue idempotency-key (PostgresJobStore)
// ---------------------------------------------------------------------------
describe("AC-1 / AC-2 / AC-3: PostgresJobStore.enqueue idempotency", () => {
  // These tests write real rows into the SHARED choros.job table. To avoid
  // racing pgJobStore.integration.test.ts's TRUNCATE+queue_stats (separate vitest
  // fork), idem jobs use a far-FUTURE available_at (FUTURE_AT) so they are NEVER
  // counted in queue depth (which filters available_at<=now), and every idem job
  // is deleted in beforeEach AND afterAll by its dedicated topic.
  const FUTURE_AT = 8_640_000_000_000; // far future ms; never <= now
  const cleanupIdemJobs = async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.job WHERE topic = 'idem-test'`);
    });
  };
  beforeEach(cleanupIdemJobs);
  afterAll(cleanupIdemJobs);

  it("AC-1: enqueue with a NEW key creates a job carrying idempotency_key", async () => {
    const key = `k-${uuid()}`;
    const job = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresJobStore(singleClientPool(client), makeFixedClock(FUTURE_AT));
      return store.enqueue("idem-test", { a: 1 }, 0, key);
    });
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT idempotency_key FROM choros.job WHERE id = $1`,
        [job.id]
      );
      expect(rows[0].idempotency_key).toBe(key);
    });
  });

  it("AC-2: repeat enqueue with same key → no duplicate; returns the first job", async () => {
    const key = `k-${uuid()}`;
    const first = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresJobStore(singleClientPool(client), makeFixedClock(FUTURE_AT));
      return store.enqueue("idem-test", { a: 1 }, 0, key);
    });
    const second = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresJobStore(singleClientPool(client), makeFixedClock(FUTURE_AT));
      return store.enqueue("idem-test", { a: 2 }, 0, key);
    });
    expect(second.id, "second enqueue must return the first job's id").toBe(first.id);
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.job WHERE idempotency_key = $1`,
        [key]
      );
      expect(rows[0].n, "exactly 1 job for the key").toBe(1);
    });
  });

  it("AC-3: enqueue WITHOUT key → two distinct jobs (backward compat)", async () => {
    const [j1, j2] = await runAsTenant(appPool, TENANT_A, async (client) => {
      const store = new PostgresJobStore(singleClientPool(client), makeFixedClock(FUTURE_AT));
      const a = await store.enqueue("idem-test", {}, 0);
      const b = await store.enqueue("idem-test", {}, 0);
      return [a, b];
    });
    expect(j1.id).not.toBe(j2.id);
  });
});

/**
 * Wrap a single PoolClient as a pg.Pool so a store bound to a GUC-scoped
 * transaction can run multiple statements on the same connection.
 */
function singleClientPool(client: pg.PoolClient): pg.Pool {
  return {
    query: client.query.bind(client),
    connect: async () => ({
      query: client.query.bind(client),
      release: () => {},
    }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// AC-16: getOutboxHealth — pendingLagMs / deadCount; broken pool → throws
// ---------------------------------------------------------------------------
describe("AC-16: getOutboxHealth", () => {
  it("pendingLagMs ≥ 0 with an overdue pending row; deadCount counts dead rows", async () => {
    await seedOutbox({ tenantId: TENANT_A, state: "pending", availableAt: 0 });
    await seedOutbox({ tenantId: TENANT_B, state: "dead", availableAt: 0 });
    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(5000));
    const h = await store.getOutboxHealth();
    expect(h.pendingLagMs).not.toBeNull();
    expect(h.pendingLagMs!).toBe(5000);
    expect(h.deadCount).toBe(1);
  });

  it("pendingLagMs null when no due pending rows", async () => {
    await seedOutbox({ tenantId: TENANT_A, state: "pending", availableAt: 10_000 });
    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(1000));
    const h = await store.getOutboxHealth();
    expect(h.pendingLagMs).toBeNull();
    expect(h.deadCount).toBe(0);
  });

  it("throws on a broken pool (caller → degraded)", async () => {
    const badPool = new pg.Pool({
      connectionString: "postgres://invalid:invalid@localhost:9999/nonexistent",
      connectionTimeoutMillis: 500,
    });
    const store = new PostgresOutboxStore(badPool, makeFixedClock(0));
    await expect(store.getOutboxHealth()).rejects.toBeDefined();
    await badPool.end().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// T-0644 (P0/столп4): reviveDeadOutboxRows — scoped one-time reconciliation for
// rows dead-lettered by the bridge/agent-dispatcher workerId mismatch.
// ---------------------------------------------------------------------------
describe("T-0644: reviveDeadOutboxRows — scoped dead → pending reconciliation", () => {
  const BRIDGE_WORKER_ID = "choros-bridge";

  it("revives a dead task_completed row whose payload.workerId differs from the bridge's own", async () => {
    const id = await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher", variables: { source: "agent", outcome: "defer" } },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(9999));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(1);

    const row = await readOutboxRow(id);
    expect(row).toBeDefined();
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toBeNull();
  });

  it("revives a dead task_failed row with a mismatched payload.workerId too", async () => {
    const id = await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "task_failed",
      payload: { workerId: "choros-agent-dispatcher", errorMessage: "llm_error", retries: 0, retryTimeout: 30000 },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(1);

    const row = await readOutboxRow(id);
    expect(row!.state).toBe("pending");
  });

  it("does NOT revive a dead row whose payload.workerId ALREADY matches the bridge (died for another reason)", async () => {
    const id = await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "task_completed",
      payload: { workerId: BRIDGE_WORKER_ID, variables: {} },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(0);

    const row = await readOutboxRow(id);
    expect(row!.state).toBe("dead"); // untouched — fail-closed, never guess.
  });

  it("does NOT revive a dead row with a mismatched workerId but a DIFFERENT eventType (e.g. worker_lock_expired)", async () => {
    const id = await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "worker_lock_expired",
      payload: { workerId: "choros-agent-dispatcher" },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(0);

    const row = await readOutboxRow(id);
    expect(row!.state).toBe("dead");
  });

  it("does NOT touch a 'pending' or 'dispatched' row even with a mismatched workerId (only 'dead' is in scope)", async () => {
    const pendingId = await seedOutbox({
      tenantId: TENANT_A,
      state: "pending",
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher" },
    });
    const dispatchedId = await seedOutbox({
      tenantId: TENANT_A,
      state: "dispatched",
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher" },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(0);

    expect((await readOutboxRow(pendingId))!.state).toBe("pending");
    expect((await readOutboxRow(dispatchedId))!.state).toBe("dispatched");
  });

  it("is idempotent — running twice revives once, second run is a no-op", async () => {
    await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher" },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const first = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(first).toBe(1);

    // Row is now 'pending' — the scoped WHERE (state='dead') no longer matches.
    const second = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(second).toBe(0);
  });

  it("scopes across ALL tenants (operator action, no GUC) — revives rows from both TENANT_A and TENANT_B", async () => {
    const idA = await seedOutbox({
      tenantId: TENANT_A,
      state: "dead",
      attempts: 5,
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher" },
    });
    const idB = await seedOutbox({
      tenantId: TENANT_B,
      state: "dead",
      attempts: 5,
      eventType: "task_completed",
      payload: { workerId: "choros-agent-dispatcher" },
    });

    const store = new PostgresOutboxStore(migratorPool, makeFixedClock(0));
    const revived = await store.reviveDeadOutboxRows(BRIDGE_WORKER_ID);
    expect(revived).toBe(2);

    expect((await readOutboxRow(idA))!.state).toBe("pending");
    expect((await readOutboxRow(idB))!.state).toBe("pending");
  });
});
