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
import {
  encodeGrantAuditEvent,
  type AuditEventInput,
} from "../../../src/core/audit-grant-encoder.js";
import { encodeLifecycleAuditEvent } from "../../../src/core/lifecycle-audit.js";
import { BOTTOM } from "../../../src/core/grant-lattice.js";

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

// ---------------------------------------------------------------------------
// T-0068 dual-writer fix: a MIXED grant + lifecycle chain stays dense & verifiable
// through the SINGLE canonical sink. Before the fix, grants.ts carried a local
// partial/non-JCS preimage stamping vocab=1 on the same tables → a verifier would
// false-positive tamper on grant rows and break density on an interleaved chain.
// Now BOTH producers (encodeGrantAuditEvent + encodeLifecycleAuditEvent) append via
// appendAuditEvent, so one preimage rule governs the whole chain.
// ---------------------------------------------------------------------------
describe("dual-writer fix — interleaved grant + lifecycle chain (single sink)", () => {
  function grantInput(idx: number): AuditEventInput {
    return encodeGrantAuditEvent(
      {
        kind: "grant.create",
        actor: "e-admin",
        subjectRoleId: `role-${idx}`,
        capability: { resourceType: "mcp://ledger.invoices", operation: "read" },
        scope: BOTTOM,
      },
      1700000000000 + idx,
    );
  }

  function lifecycleInput(idx: number): AuditEventInput {
    return encodeLifecycleAuditEvent(
      {
        kind: "task.completed",
        instanceId: `pi-${idx}`,
        jobId: `job-${idx}`,
        actor: "bridge-worker",
        actorType: "service",
      },
      1700000000000 + idx,
    );
  }

  it("interleaved grant/lifecycle appends form a dense +1 chain with one preimage rule", async () => {
    const t = freshTenant();
    // Interleave the two producers: grant, lifecycle, grant, lifecycle, grant, lifecycle.
    const inputs: AuditEventInput[] = [
      grantInput(1),
      lifecycleInput(2),
      grantInput(3),
      lifecycleInput(4),
      grantInput(5),
      lifecycleInput(6),
    ];
    for (let i = 0; i < inputs.length; i++) {
      const res = await withTenantClient(t, (tx) => writer.appendAuditEvent(tx, inputs[i]));
      expect(res.seq).toBe(i + 1);
    }

    await withTenantClient(t, async (_tx, raw) => {
      const rows = (
        await raw.query(
          `SELECT seq::int AS seq, type, prev_hash, row_hash, vocab_version::int AS vocab_version
             FROM choros.audit_event ORDER BY seq`,
        )
      ).rows;

      // Dense 1..6, the two event kinds interleaved, all under vocab_version=1.
      expect(rows.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows.map((r: { type: string }) => r.type)).toEqual([
        "grant.create",
        "task.completed",
        "grant.create",
        "task.completed",
        "grant.create",
        "task.completed",
      ]);
      for (const r of rows as Array<{ vocab_version: number }>) {
        expect(r.vocab_version).toBe(1);
      }

      // Chain density: prev_hash[n] === row_hash[n-1] across BOTH producers.
      expect(Buffer.from(rows[0].prev_hash).equals(GENESIS_PREV_HASH)).toBe(true);
      for (let i = 1; i < rows.length; i++) {
        expect(Buffer.from(rows[i].prev_hash).equals(Buffer.from(rows[i - 1].row_hash))).toBe(true);
      }

      const head = (await raw.query(`SELECT seq::int AS seq, row_hash FROM choros.audit_head`)).rows[0];
      expect(head.seq).toBe(6);
      expect(Buffer.from(head.row_hash).equals(Buffer.from(rows[5].row_hash))).toBe(true);
    });
  });

  it("tamper-detect on the MIXED chain: mutating a grant row's payload diverges its canonical recompute", async () => {
    const t = freshTenant();
    const g = grantInput(1);
    const l = lifecycleInput(2);
    await withTenantClient(t, (tx) => writer.appendAuditEvent(tx, g));
    await withTenantClient(t, (tx) => writer.appendAuditEvent(tx, l));

    await withTenantClient(t, async (_tx, raw) => {
      const rows = (
        await raw.query(
          `SELECT seq::int AS seq, id, type, actor, subject, scope, via,
                  proposed_by, confirmed_by, payload, occurred_at::float8 AS occurred_at,
                  prev_hash, row_hash
             FROM choros.audit_event ORDER BY seq`,
        )
      ).rows;

      // The stored grant row (seq=1) verifies against the canonical recompute.
      const stored = rows[0];
      const honest: CanonicalAuditRow = {
        tenant_id: t,
        seq: 1,
        id: g.id,
        type: g.type,
        actor: g.actor,
        subject: g.subject,
        scope: g.scope ?? null,
        via: g.via,
        proposed_by: g.proposed_by,
        confirmed_by: g.confirmed_by,
        payload: g.payload,
        occurred_at: g.occurred_at,
        prev_hash: GENESIS_PREV_HASH,
        vocab_version: 1,
      };
      expect(Buffer.from(stored.row_hash).equals(rowHash(honest))).toBe(true);

      // Tamper: flip the grant payload operation. The recompute now diverges from
      // the stored row_hash — proving the grant row is hash-covered on the mixed
      // chain by the SAME rule that covers the lifecycle row (no dual preimage).
      const tampered: CanonicalAuditRow = {
        ...honest,
        payload: { ...(g.payload as Record<string, unknown>), operation: "delete" },
      };
      expect(Buffer.from(stored.row_hash).equals(rowHash(tampered))).toBe(false);

      // And the lifecycle row at seq=2 chains onto the (honest) grant row_hash.
      expect(Buffer.from(rows[1].prev_hash).equals(Buffer.from(stored.row_hash))).toBe(true);
    });
  });
});
