// T-0019 · live Postgres behavioral tests for the actor_event ledger (E4.1).
// Run in the `db` CI job / locally: DATABASE_URL=… npm run fitness:db
//
// Covers the live-DB ACs:
//   AC-1  — FORCE RLS + default-DENY: choros_app with no GUC → 0 rows.
//   AC-3  — PK is (tenant_id, seq); object index leads with tenant_id.
//   AC-4  — choros_app cannot UPDATE a row (privilege/trigger).
//   AC-5  — choros_app cannot DELETE a row.
//   AC-6  — owner (choros_migrator) UPDATE/DELETE barred by the no-mutate trigger.
//   AC-8  — seq is per-tenant strictly-increasing + UNIQUE; tenants order independently.
//   AC-9  — N concurrent appends in a tenant yield N distinct seq (per-tenant counter).
//   AC-10 — actor NOT NULL + FK→employee.
//   AC-11 — on_behalf_of nullable + FK→employee, distinct from actor.
//   AC-14 — role_at_event NOT NULL, accepts a non-existent role uuid (no FK).
//   AC-15 — object_kind CHECK; component ids non-FK (record_id absent from record accepted).
//   AC-16 — per-object trail ordered by seq, index-served, isolated to that object.
//   AC-18 — closed verb CHECK rejects an out-of-set verb; the five verbs accepted.
//   AC-19 — approve_level IFF approve, ≥1; L1/L2 distinguishable on read.
//
// Seed strategy: all writes via migratorUrl() (bypasses RLS); the append-path
// serialization is exercised directly (this file IS the per-tenant counter writer
// stand-in for the test — the real writer is T-0021/E4.2).

import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';

// Two isolated test tenants for this suite (avoid colliding with the shared
// cross_tenant seeds by using dedicated tenant ids).
const T_AE_A = '33333333-3333-3333-3333-333333333333';
const T_AE_B = '44444444-4444-4444-4444-444444444444';

// ---------------------------------------------------------------------------
// Seed scaffolding: a tenant → department → position → employee chain so we
// have a valid `actor` FK target per tenant.
// ---------------------------------------------------------------------------
async function ensureTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `ae-tenant-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(c: pg.Client, tenantId: string): Promise<string> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, deptId, `ae-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, posId, deptId, `ae-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, empId, posId, `ae-emp-${empId.slice(0, 8)}`],
  );
  return empId;
}

const seeded = { empA: '', empB: '', agentA: '' };

// Per-run random seq offset so the suite is RE-RUNNABLE against a shared/persisted
// DB: the COMMIT-ing inserts leave rows behind, and fixed seq literals would
// collide on a second run. Offsetting every fixed seq by the same random base
// preserves within-run uniqueness/ordering while avoiding cross-run PK clashes.
// (On fresh CI the suite runs once; this only matters for the shared silo.)
const SEQ_BASE = 100_000 + Math.floor(Math.random() * 900_000_000);
const S = (n: number): number => SEQ_BASE + n;

/** Append one actor_event row via the migrator using an explicit seq. */
async function appendRow(
  c: pg.Client,
  args: {
    tenantId: string;
    seq: number;
    actor: string;
    onBehalfOf?: string | null;
    roleAtEvent?: string;
    event?: string;
    approveLevel?: number | null;
    objectKind?: string;
    recordId?: string | null;
    applicationId?: string | null;
    registryId?: string | null;
  },
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.actor_event
       (tenant_id, seq, id, object_kind, application_id, registry_id, record_id,
        actor, on_behalf_of, role_at_event, event, approve_level, ts, vocab_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, 1)`,
    [
      args.tenantId,
      args.seq,
      id,
      args.objectKind ?? 'record',
      args.applicationId ?? null,
      args.registryId ?? null,
      args.objectKind === undefined || args.objectKind === 'record'
        ? args.recordId ?? uuid()
        : args.recordId ?? null,
      args.actor,
      args.onBehalfOf ?? null,
      args.roleAtEvent ?? uuid(),
      args.event ?? 'submit',
      args.approveLevel ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await ensureTenant(c, T_AE_A);
    await ensureTenant(c, T_AE_B);
    await c.query('COMMIT');
    await c.query('BEGIN');
    seeded.empA = await seedEmployee(c, T_AE_A);
    seeded.agentA = await seedEmployee(c, T_AE_A);
    seeded.empB = await seedEmployee(c, T_AE_B);
    await c.query('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// AC-1 — FORCE RLS + default-DENY
// ---------------------------------------------------------------------------
describe('AC-1: actor_event is FORCE-RLS default-DENY', () => {
  it('pg_class shows relrowsecurity AND relforcerowsecurity', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class cls
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname='actor_event'`,
      );
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);
    });
  });

  it('choros_app with no tenant GUC sees 0 rows', async () => {
    // Seed one row so a leak would be visible.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(1000), actor: seeded.empA });
      await c.query('COMMIT');
    });
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM choros.actor_event`);
      expect(rows[0].n).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3 — PK (tenant_id, seq); object index leads with tenant_id
// ---------------------------------------------------------------------------
describe('AC-3: PK (tenant_id, seq) and tenant_id-leading object index', () => {
  it('the primary key is exactly (tenant_id, seq)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT a.attname, array_position(i.indkey::int[], a.attnum) AS pos
           FROM pg_index i
           JOIN pg_class cls ON cls.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE ns.nspname='choros' AND cls.relname='actor_event' AND i.indisprimary
          ORDER BY pos`,
      );
      expect(rows.map((r) => r.attname)).toEqual(['tenant_id', 'seq']);
    });
  });

  it('the object-read index exists and leads with tenant_id', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_class cls ON cls.oid = i.indrelid
           JOIN pg_class idxc ON idxc.oid = i.indexrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE ns.nspname='choros' AND cls.relname='actor_event'
            AND idxc.relname='actor_event_object_read'`,
      );
      expect(rows[0].attname).toBe('tenant_id');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5 — choros_app cannot UPDATE / DELETE
// ---------------------------------------------------------------------------
describe('AC-4/5: choros_app cannot UPDATE or DELETE an actor_event row', () => {
  beforeAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(2001), actor: seeded.empA, event: 'submit' });
      await c.query('COMMIT');
    });
  });

  it('UPDATE from choros_app fails (privilege or trigger)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${T_AE_A}'`);
      await expect(
        c.query(`UPDATE choros.actor_event SET event='approve' WHERE seq=${S(2001)}`),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
    // Row unchanged on re-read via migrator.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT event FROM choros.actor_event WHERE tenant_id=$1 AND seq=${S(2001)}`,
        [T_AE_A],
      );
      expect(rows[0].event).toBe('submit');
    });
  });

  it('DELETE from choros_app fails; row survives', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${T_AE_A}'`);
      await expect(
        c.query(`DELETE FROM choros.actor_event WHERE seq=${S(2001)}`),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.actor_event WHERE tenant_id=$1 AND seq=${S(2001)}`,
        [T_AE_A],
      );
      expect(rows[0].n).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6 — owner UPDATE/DELETE barred by the no-mutate trigger (defence in depth)
// ---------------------------------------------------------------------------
describe('AC-6: the no-mutate trigger bars UPDATE/DELETE even for the owner', () => {
  beforeAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(3001), actor: seeded.empA });
      await c.query('COMMIT');
    });
  });

  // The no-mutate trigger RAISEs with ERRCODE='restrict_violation' → SQLSTATE
  // 23001 (integrity-constraint-violation class). The point is the trigger fires
  // for the owner too (defence in depth) — assert the restrict_violation code.
  it('migrator (owner) UPDATE is rejected by the trigger (23001 restrict_violation)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await expect(
        c.query(`UPDATE choros.actor_event SET event='release' WHERE tenant_id=$1 AND seq=${S(3001)}`, [T_AE_A]),
      ).rejects.toMatchObject({ code: '23001' });
    });
  });

  it('migrator (owner) DELETE is rejected by the trigger (23001 restrict_violation)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await expect(
        c.query(`DELETE FROM choros.actor_event WHERE tenant_id=$1 AND seq=${S(3001)}`, [T_AE_A]),
      ).rejects.toMatchObject({ code: '23001' });
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8 — per-tenant strictly-increasing UNIQUE seq; tenants order independently
// ---------------------------------------------------------------------------
describe('AC-8: seq is per-tenant strictly-increasing + UNIQUE', () => {
  it('a duplicate (tenant_id, seq) is rejected (23505)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(4001), actor: seeded.empA });
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(4001), actor: seeded.empA }),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');
    });
  });

  it('the same seq value is independently usable in another tenant', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(4100), actor: seeded.empA });
      await appendRow(c, { tenantId: T_AE_B, seq: S(4100), actor: seeded.empB });
      await c.query('COMMIT');
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.actor_event WHERE seq=${S(4100)}`,
      );
      expect(rows[0].n).toBe(2); // one per tenant, no collision
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9 — the per-tenant counter: N concurrent appends yield N distinct seq
// ---------------------------------------------------------------------------
describe('AC-9: per-tenant counter row serializes seq under FOR UPDATE', () => {
  it('N concurrent appends via actor_event_seq yield N distinct seq values', async () => {
    // Ensure the genesis counter row exists.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.actor_event_seq (tenant_id, next_seq) VALUES ($1, 5000)
         ON CONFLICT (tenant_id) DO UPDATE SET next_seq = GREATEST(choros.actor_event_seq.next_seq, 5000)`,
        [T_AE_B],
      );
    });

    const N = 8;
    // Each worker: own connection, advance the counter under FOR UPDATE, append.
    async function worker(): Promise<number> {
      const client = new pg.Client({ connectionString: migratorUrl() });
      await client.connect();
      try {
        await client.query('SET search_path TO choros;');
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT next_seq FROM choros.actor_event_seq WHERE tenant_id=$1 FOR UPDATE`,
          [T_AE_B],
        );
        const seq = Number(rows[0].next_seq);
        await client.query(
          `UPDATE choros.actor_event_seq SET next_seq = next_seq + 1 WHERE tenant_id=$1`,
          [T_AE_B],
        );
        await appendRow(client as unknown as pg.Client, { tenantId: T_AE_B, seq, actor: seeded.empB });
        await client.query('COMMIT');
        return seq;
      } finally {
        await client.end();
      }
    }

    const seqs = await Promise.all(Array.from({ length: N }, () => worker()));
    const distinct = new Set(seqs);
    expect(distinct.size, `expected ${N} distinct seq, got ${[...distinct].sort().join(',')}`).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// AC-10 — actor NOT NULL + FK→employee
// ---------------------------------------------------------------------------
describe('AC-10: actor is NOT NULL and FK-scoped to employee', () => {
  it('actor = a non-existent employee.id is rejected by the FK (23503)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(6001), actor: uuid() }),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('actor = NULL is rejected by NOT NULL (23502)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.actor_event
             (tenant_id, seq, id, object_kind, record_id, actor, role_at_event, event, ts, vocab_version)
           VALUES ($1, 6002, $2, 'record', $3, NULL, $3, 'submit', 0, 1)`,
          [T_AE_A, uuid(), uuid()],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });

  it('actor = a valid employee.id succeeds', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(6003), actor: seeded.empA });
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11 — on_behalf_of nullable, FK-scoped, distinct from actor
// ---------------------------------------------------------------------------
describe('AC-11: on_behalf_of nullable + FK, distinct from actor', () => {
  it('on_behalf_of = NULL is valid (acted on own behalf)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(7001), actor: seeded.empA, onBehalfOf: null });
      await c.query('COMMIT');
    });
  });

  it('on_behalf_of = a different valid employee is preserved on read (≠ actor)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, {
        tenantId: T_AE_A,
        seq: S(7002),
        actor: seeded.empA,
        onBehalfOf: seeded.agentA,
      });
      await c.query('COMMIT');
      const { rows } = await c.query(
        `SELECT actor, on_behalf_of FROM choros.actor_event WHERE tenant_id=$1 AND seq=${S(7002)}`,
        [T_AE_A],
      );
      expect(rows[0].on_behalf_of).toBe(seeded.agentA);
      expect(rows[0].on_behalf_of).not.toBe(rows[0].actor);
    });
  });

  it('on_behalf_of = a non-existent employee is rejected by the FK (23503)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(7003), actor: seeded.empA, onBehalfOf: uuid() }),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-14 — role_at_event NOT NULL, accepts a non-existent role uuid (no FK)
// ---------------------------------------------------------------------------
describe('AC-14: role_at_event NOT NULL, no FK to role', () => {
  it('role_at_event = NULL is rejected by NOT NULL (23502)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.actor_event
             (tenant_id, seq, id, object_kind, record_id, actor, role_at_event, event, ts, vocab_version)
           VALUES ($1, 8001, $2, 'record', $3, $4, NULL, 'submit', 0, 1)`,
          [T_AE_A, uuid(), uuid(), seeded.empA],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });

  it('role_at_event = a non-existent role uuid is ACCEPTED (no FK)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(8002), actor: seeded.empA, roleAtEvent: uuid() });
      await c.query('COMMIT');
    });
  });

  it('actor_event has no FK to a role/assignment table', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ref.relname AS dst
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_class ref ON ref.oid = con.confrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname='actor_event' AND con.contype='f'`,
      );
      const targets = rows.map((r) => r.dst);
      expect(targets).not.toContain('role');
      expect(targets).not.toContain('assignment');
      // The only FKs are to employee (actor / on_behalf_of).
      for (const t of targets) expect(t).toBe('employee');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-15 — object_kind CHECK; component ids non-FK
// ---------------------------------------------------------------------------
describe('AC-15: object_kind CHECK + denormalized non-FK component ids', () => {
  it("object_kind='robot' is rejected by the CHECK (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(9001), actor: seeded.empA, objectKind: 'robot', recordId: uuid() }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it('a record-kind row with a record_id absent from `record` is ACCEPTED (no FK)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(9002), actor: seeded.empA, objectKind: 'record', recordId: uuid() });
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-16 — per-object trail ordered by seq, index-served, object-isolated
// ---------------------------------------------------------------------------
describe('AC-16: per-object trail is ordered, index-served, complete', () => {
  it('request→prepare→submit→approve@L1→approve@L2→release reads back in seq order', async () => {
    const recId = uuid();
    const otherRec = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(9100), actor: seeded.empA, event: 'request', recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9101), actor: seeded.empA, event: 'prepare', recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9102), actor: seeded.empA, event: 'submit', recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9103), actor: seeded.empA, event: 'approve', approveLevel: 1, recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9104), actor: seeded.empA, event: 'approve', approveLevel: 2, recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9105), actor: seeded.empA, event: 'release', recordId: recId });
      // An event for a DIFFERENT object must not appear in this trail.
      await appendRow(c, { tenantId: T_AE_A, seq: S(9106), actor: seeded.empA, event: 'submit', recordId: otherRec });
      await c.query('COMMIT');

      const { rows } = await c.query(
        `SELECT event, approve_level FROM choros.actor_event
          WHERE tenant_id=$1 AND object_kind='record' AND record_id=$2
          ORDER BY seq`,
        [T_AE_A, recId],
      );
      expect(rows.map((r) => r.event)).toEqual([
        'request', 'prepare', 'submit', 'approve', 'approve', 'release',
      ]);
      expect(rows[3].approve_level).toBe(1);
      expect(rows[4].approve_level).toBe(2);
    });
  });

  it('the object-scoped read uses the object index, not a seq scan', async () => {
    const recId = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(9200), actor: seeded.empA, recordId: recId });
      await c.query('COMMIT');
      // Force index usage to be preferred for the probe (tiny tables otherwise seq-scan).
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = await c.query(
        `EXPLAIN SELECT * FROM choros.actor_event
          WHERE tenant_id=$1 AND object_kind='record' AND record_id=$2 ORDER BY seq`,
        [T_AE_A, recId],
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toMatch(/Index (Only )?Scan/);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-18 — closed verb CHECK
// ---------------------------------------------------------------------------
describe('AC-18: the verb set is closed (CHECK-enforced)', () => {
  it("event='escalate' is rejected by the CHECK (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(9300), actor: seeded.empA, event: 'escalate' }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it('each of the five valid verbs is accepted', async () => {
    const verbs: Array<[string, number | null]> = [
      ['request', null], ['prepare', null], ['submit', null],
      ['approve', 1], ['release', null],
    ];
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      let seq = S(9310);
      for (const [event, lvl] of verbs) {
        await appendRow(c, { tenantId: T_AE_A, seq: seq++, actor: seeded.empA, event, approveLevel: lvl });
      }
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-19 — approve_level IFF approve, ≥1; L1/L2 distinguishable
// ---------------------------------------------------------------------------
describe('AC-19: approve_level non-null IFF approve', () => {
  it("approve with approve_level=NULL is rejected (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(9400), actor: seeded.empA, event: 'approve', approveLevel: null }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it("submit with approve_level=2 is rejected (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(9401), actor: seeded.empA, event: 'submit', approveLevel: 2 }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it("approve_level=0 is rejected by the ≥1 CHECK (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        appendRow(c, { tenantId: T_AE_A, seq: S(9402), actor: seeded.empA, event: 'approve', approveLevel: 0 }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it('approve@L1 and approve@L2 are both accepted and orderable on read', async () => {
    const recId = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await appendRow(c, { tenantId: T_AE_A, seq: S(9410), actor: seeded.empA, event: 'approve', approveLevel: 1, recordId: recId });
      await appendRow(c, { tenantId: T_AE_A, seq: S(9411), actor: seeded.empA, event: 'approve', approveLevel: 2, recordId: recId });
      await c.query('COMMIT');
      const { rows } = await c.query(
        `SELECT approve_level FROM choros.actor_event
          WHERE tenant_id=$1 AND record_id=$2 ORDER BY approve_level`,
        [T_AE_A, recId],
      );
      expect(rows.map((r) => r.approve_level)).toEqual([1, 2]);
    });
  });
});
