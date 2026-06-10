// T-0068 · live Postgres probes for the canonical audit writer (FF-1 / FF-2b).
//
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// Covers the live-DB ACs:
//   AC-1 (FF-1)  — genesis anchor: first append → seq=1, prev_hash=32×0x00,
//                  row_hash=SHA256(preimage); audit_head=(1,row_hash).
//   AC-2 (FF-1)  — dense chain: 3 sequential appends → seq 1,2,3; prev_hash[n] =
//                  row_hash[n-1]; head=(3,row_hash_3).
//   AC-5 (FF-1)  — atomicity: ROLLBACK undoes both the event row and the head
//                  advance; after COMMIT both are visible and consistent.
//   AC-4 (FF-2b) — per-tenant serialization: N concurrent appends in tenant-A →
//                  N dense distinct seq; tenant-A and tenant-B do not block.
//
// The writer runs against choros_app (the runtime role) under the choros.tenant_id
// GUC — exactly the production path.

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl } from "./_helpers.js";
import { makePgAuditWriter, type PgClientLike } from "../../../src/db/audit-writer.js";
import { rowHash, GENESIS_PREV_HASH, type CanonicalAuditRow } from "../../../src/core/audit-preimage.js";
import type { AuditEventInput } from "../../../src/core/audit-grant-encoder.js";

const { Client } = pg;

const writer = makePgAuditWriter();

function input(over: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    id: crypto.randomUUID(),
    type: "instance.started",
    actor: "e-larina",
    subject: "pi-1",
    scope: null,
    via: "engine",
    proposed_by: null,
    confirmed_by: null,
    payload: { actorType: "human", instanceId: "pi-1", processKey: "invoice" },
    occurred_at: 1700000000000,
    ...over,
  };
}

/** Open a tenant tx on a fresh client (choros_app), set the GUC, run fn. */
async function withTenantClient<T>(
  tenantId: string,
  fn: (tx: PgClientLike, raw: pg.Client) => Promise<T>,
  commit = true,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    const result = await fn(c as unknown as PgClientLike, c);
    if (commit) await c.query("COMMIT");
    else await c.query("ROLLBACK");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/** Wipe both test tenants' chains via the migrator (bypasses no-mutate trigger? no —
 *  audit_event/head are immutable; we instead use FRESH random tenants per run). */
function freshTenant(): string {
  return crypto.randomUUID();
}

describe("FF-1 — genesis anchor + dense chain (AC-1/2/5)", () => {
  it("first append writes the genesis anchor (seq=1, prev=32×0x00)", async () => {
    const t = freshTenant();
    const ev = input();
    const res = await withTenantClient(t, (tx) => writer.appendAuditEvent(tx, ev));
    expect(res.seq).toBe(1);

    await withTenantClient(t, async (_tx, raw) => {
      const evRow = await raw.query(
        `SELECT seq::int AS seq, prev_hash, row_hash FROM choros.audit_event WHERE seq=1`,
      );
      expect(evRow.rows.length).toBe(1);
      expect(Buffer.from(evRow.rows[0].prev_hash).equals(GENESIS_PREV_HASH)).toBe(true);

      // row_hash matches the canonical recompute.
      const recompute: CanonicalAuditRow = {
        tenant_id: t,
        seq: 1,
        id: ev.id,
        type: ev.type,
        actor: ev.actor,
        subject: ev.subject,
        scope: ev.scope ?? null,
        via: ev.via,
        proposed_by: ev.proposed_by,
        confirmed_by: ev.confirmed_by,
        payload: ev.payload,
        occurred_at: ev.occurred_at,
        prev_hash: GENESIS_PREV_HASH,
        vocab_version: 1,
      };
      expect(Buffer.from(evRow.rows[0].row_hash).equals(rowHash(recompute))).toBe(true);

      const head = await raw.query(
        `SELECT seq::int AS seq, row_hash FROM choros.audit_head`,
      );
      expect(head.rows[0].seq).toBe(1);
      expect(Buffer.from(head.rows[0].row_hash).equals(Buffer.from(evRow.rows[0].row_hash))).toBe(true);
    });
  });

  it("three sequential appends form a dense +1 chain (prev_hash[n]=row_hash[n-1])", async () => {
    const t = freshTenant();
    const hashes: Buffer[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await withTenantClient(t, (tx) =>
        writer.appendAuditEvent(tx, input({ subject: `pi-${i}` })),
      );
      expect(res.seq).toBe(i);
      hashes.push(res.rowHash);
    }

    await withTenantClient(t, async (_tx, raw) => {
      const rows = (
        await raw.query(`SELECT seq::int AS seq, prev_hash, row_hash FROM choros.audit_event ORDER BY seq`)
      ).rows;
      expect(rows.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3]);
      expect(Buffer.from(rows[0].prev_hash).equals(GENESIS_PREV_HASH)).toBe(true);
      expect(Buffer.from(rows[1].prev_hash).equals(Buffer.from(rows[0].row_hash))).toBe(true);
      expect(Buffer.from(rows[2].prev_hash).equals(Buffer.from(rows[1].row_hash))).toBe(true);

      const head = (await raw.query(`SELECT seq::int AS seq, row_hash FROM choros.audit_head`)).rows[0];
      expect(head.seq).toBe(3);
      expect(Buffer.from(head.row_hash).equals(Buffer.from(rows[2].row_hash))).toBe(true);
    });
  });

  it("ROLLBACK undoes both the event row and the head advance (AC-5)", async () => {
    const t = freshTenant();
    // Append inside a tx that is rolled back.
    await withTenantClient(
      t,
      async (tx) => {
        await writer.appendAuditEvent(tx, input());
      },
      false, // ROLLBACK
    );
    // Nothing should be visible.
    await withTenantClient(t, async (_tx, raw) => {
      const ev = await raw.query(`SELECT count(*)::int AS n FROM choros.audit_event`);
      const head = await raw.query(`SELECT count(*)::int AS n FROM choros.audit_head`);
      expect(ev.rows[0].n).toBe(0);
      expect(head.rows[0].n).toBe(0);
    });
    // After a COMMIT-ing append, both are visible and consistent.
    const res = await withTenantClient(t, (tx) => writer.appendAuditEvent(tx, input()));
    await withTenantClient(t, async (_tx, raw) => {
      const head = (await raw.query(`SELECT seq::int AS seq FROM choros.audit_head`)).rows[0];
      const ev = (await raw.query(`SELECT count(*)::int AS n FROM choros.audit_event`)).rows[0];
      expect(head.seq).toBe(res.seq);
      expect(ev.n).toBe(1);
    });
  });
});

describe("FF-2b — per-tenant serialization, no cross-tenant block (AC-4)", () => {
  it("N concurrent appends in one tenant yield N dense distinct seq", async () => {
    const t = freshTenant();
    const N = 8;
    // Each append takes its own connection + tx → real concurrency; the writer's
    // FOR UPDATE / genesis-retry serialize them into a dense chain.
    await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        withTenantClient(t, (tx) => writer.appendAuditEvent(tx, input({ subject: `c-${i}` }))),
      ),
    );
    await withTenantClient(t, async (_tx, raw) => {
      const rows = (await raw.query(`SELECT seq::int AS seq FROM choros.audit_event ORDER BY seq`)).rows;
      const seqs = rows.map((r: { seq: number }) => r.seq);
      expect(seqs.length).toBe(N);
      // Dense, distinct, 1..N.
      expect(seqs).toEqual(Array.from({ length: N }, (_v, i) => i + 1));
      const head = (await raw.query(`SELECT seq::int AS seq FROM choros.audit_head`)).rows[0];
      expect(head.seq).toBe(N);
    });
  });

  it("appends in tenant-A and tenant-B do not block each other (independent chains)", async () => {
    const a = freshTenant();
    const b = freshTenant();
    const [ra, rb] = await Promise.all([
      withTenantClient(a, (tx) => writer.appendAuditEvent(tx, input())),
      withTenantClient(b, (tx) => writer.appendAuditEvent(tx, input())),
    ]);
    expect(ra.seq).toBe(1);
    expect(rb.seq).toBe(1);
  });
});
