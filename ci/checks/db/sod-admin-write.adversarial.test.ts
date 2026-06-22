// T-0417 · ADVERSARY (Враг red-team) — SoD constraint WRITE-endpoint security.
//
// Surface under attack: T-0386 (SoD constraint CRUD write API) + T-0409
//   (hash-chain SoD mutations into audit_event, atomic).
//   src/db/sod-dao.ts  (createSodConstraintInTx / updateSodConstraintInTx /
//   deleteSodConstraintInTx) + src/http/rights-sod-admin.ts (owner-only gate +
//   one-transaction CRUD⊕audit).
//
// CI-ONLY: requires the pinned postgres:16 service (npm run fitness:db). Skipped
// in the ambient-free `ci` job. Assumes migrations applied (the db job runs the
// runner ×2 before these suites).
//
// Attack vectors:
//   A1  CROSS-TENANT WRITE: a session bound to TENANT_B cannot INSERT a
//       sod_constraint row whose tenant_id = TENANT_A (RLS WITH CHECK). And a
//       TENANT_B session cannot UPDATE/DELETE a TENANT_A row (RLS USING → 0 rows
//       affected, NOT an error that leaks existence).
//   A2  STATIC-SHAPE bypass via UPDATE: nulling role_a/role_b on a static row
//       (making it shapeless) must be rejected by the DB CHECK (defence in depth
//       behind the DAO's own re-validation).
//   A3  AUDIT-SKIP / ATOMICITY (T-0409): the route commits the sod_constraint
//       mutation and its hash-chained audit_event in ONE transaction. If the
//       audit append throws, the constraint write MUST roll back — no mute
//       mutation. We exercise this directly on a pg client: INSERT constraint,
//       then throw before COMMIT → ROLLBACK → zero rows persisted.
//   A4  AUDIT-PAIRING: a successfully committed sod.create leaves BOTH the
//       constraint row AND a matching audit_event (subject == constraint id).

import { describe, it, expect } from 'vitest';
import {
  migratorUrl,
  appUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';
import {
  createSodConstraintInTx,
  updateSodConstraintInTx,
  deleteSodConstraintInTx,
  type SodTxClient,
} from '../../../src/db/sod-dao.js';

// ---------------------------------------------------------------------------
// A1 — cross-tenant write is RLS-blocked
// ---------------------------------------------------------------------------
describe('Враг · SoD write — cross-tenant isolation (RLS WITH CHECK / USING)', () => {
  it('A1a: a TENANT_B-bound choros_app session cannot INSERT a TENANT_A sod_constraint row', async () => {
    const forgedId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      // Forge tenant_id = TENANT_A while bound to TENANT_B → RLS WITH CHECK must
      // reject ("new row violates row-level security policy", SQLSTATE 42501).
      await expect(
        c.query(
          `INSERT INTO choros.sod_constraint
             (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
           VALUES ($1, $2, 'dynamic', NULL, NULL, true, '{}'::jsonb, NULL, 0)`,
          [TENANT_A, forgedId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    // Belt-and-suspenders: the forged row never persisted under TENANT_A.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint WHERE id = $1`,
        [forgedId],
      );
      expect(rows[0].n, 'forged cross-tenant row must not exist').toBe(0);
    });
  });

  it('A1b: a TENANT_A row cannot be UPDATEd or DELETEd from a TENANT_B session (0 rows, no leak)', async () => {
    const rowId = uuid();
    // Seed a TENANT_A dynamic row via the owner (migrator) so it exists.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.sod_constraint
           (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
         VALUES ($1, $2, 'dynamic', NULL, NULL, true, '{}'::jsonb, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, rowId],
      );
      await c.query('COMMIT');
    });

    // A TENANT_B-bound app session: UPDATE and DELETE must affect 0 rows (RLS USING
    // hides the row — it neither errors nor mutates cross-tenant data).
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const upd = await c.query(
        `UPDATE choros.sod_constraint SET self_record = false WHERE id = $1`,
        [rowId],
      );
      expect(upd.rowCount ?? 0, 'cross-tenant UPDATE must touch 0 rows').toBe(0);
      const del = await c.query(
        `DELETE FROM choros.sod_constraint WHERE id = $1`,
        [rowId],
      );
      expect(del.rowCount ?? 0, 'cross-tenant DELETE must touch 0 rows').toBe(0);
      await c.query('COMMIT');
    });

    // Confirm the TENANT_A row survived untouched (still self_record = true).
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT self_record FROM choros.sod_constraint WHERE id = $1`,
        [rowId],
      );
      expect(rows.length, 'TENANT_A row must still exist').toBe(1);
      expect(rows[0].self_record, 'TENANT_A row must be unmodified').toBe(true);
    });

    // Cleanup.
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.sod_constraint WHERE id = $1`, [rowId]);
    });
  });

  it('A1c: createSodConstraintInTx (DAO) into TENANT_A from a TENANT_B-bound client is RLS-rejected', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      // Drive the DAO with the WRONG tenant id (TENANT_A) on a TENANT_B-bound tx —
      // the INSERT's WITH CHECK fails. The DAO does not open its own tx (InTx), so
      // the RLS policy of the open TENANT_B context applies.
      await expect(
        createSodConstraintInTx(c as unknown as SodTxClient, TENANT_A, {
          kind: 'dynamic',
          selfRecord: true,
          scope: {},
        }),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// A2 — static-shape invariant cannot be bypassed at the DB layer
// ---------------------------------------------------------------------------
describe('Враг · SoD write — static-shape CHECK is defence-in-depth', () => {
  it('A2: nulling role_a on a static row via raw UPDATE is rejected by the DB CHECK (23514)', async () => {
    const rowId = uuid();
    const roleA = uuid();
    const roleB = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.sod_constraint
           (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
         VALUES ($1, $2, 'static', $3, $4, false, '{}'::jsonb, NULL, 0)`,
        [TENANT_A, rowId, roleA, roleB],
      );
      await c.query('COMMIT');

      // Attempt to make the static row shapeless (role_a NULL) — DB CHECK rejects.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `UPDATE choros.sod_constraint SET role_a = NULL WHERE id = $1`,
          [rowId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');

      // Cleanup.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(`DELETE FROM choros.sod_constraint WHERE id = $1`, [rowId]);
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// A3 — audit-skip / atomicity: a mutation with no audit_event must not persist
// ---------------------------------------------------------------------------
describe('Враг · SoD write — atomicity: no mute mutation (T-0409)', () => {
  it('A3: INSERT sod_constraint then THROW before COMMIT → ROLLBACK leaves zero rows', async () => {
    let newId = '';
    await withClient(appUrl(), async (c) => {
      // Mirror the route's tx: BEGIN; SET LOCAL; createSodConstraintInTx; <audit
      // append throws>; ROLLBACK. The route wraps both in one tx, so a thrown
      // audit step rolls the constraint write back.
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await c.query('SET LOCAL search_path TO choros');
        newId = await createSodConstraintInTx(c as unknown as SodTxClient, TENANT_A, {
          kind: 'dynamic',
          selfRecord: true,
          scope: {},
        });
        expect(newId).toBeTruthy();
        // Simulate the audit-append failure inside the SAME transaction.
        throw new Error('simulated audit append failure — tx must roll back');
      } catch {
        await c.query('ROLLBACK');
      }
    });

    // The exact constraint row we inserted must NOT have persisted (atomic rollback).
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint WHERE id = $1`,
        [newId],
      );
      expect(rows[0].n, 'rolled-back constraint row must be absent (no mute mutation)').toBe(0);
    });
  });

  it('A4: a committed sod.create leaves BOTH the constraint row AND a paired audit_event', async () => {
    // Drive the route's atomic unit directly: constraint INSERT + audit_event INSERT
    // in one tx, then COMMIT. Confirm both rows exist with subject == constraint id.
    const { makePgAuditWriter } = await import('../../../src/db/audit-writer.js');
    const { encodeSodMutationAuditEvent } = await import('../../../src/core/audit-grant-encoder.js');
    const writer = makePgAuditWriter();

    let newId = '';
    // Use the migrator connection for the write: on a fresh DB TENANT_A has no
    // audit_head row yet, and the writer's seed-head INSERT (GENESIS_PREV_HASH)
    // needs a role that can establish it. The RLS/permission aspect is covered by
    // A1/A2; A4 asserts the atomicity-pairing property (constraint + paired
    // audit_event committed together), which is connection-agnostic.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query('SET LOCAL search_path TO choros');
      newId = await createSodConstraintInTx(c as unknown as SodTxClient, TENANT_A, {
        kind: 'dynamic',
        selfRecord: true,
        scope: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writer.appendAuditEvent(c as any, encodeSodMutationAuditEvent(
        { kind: 'sod.create', actor: 'e-owner', constraintId: newId, constraintKind: 'dynamic' },
        Date.now(),
      ));
      await c.query('COMMIT');
    });

    await withClient(migratorUrl(), async (c) => {
      const constraint = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint WHERE id = $1`,
        [newId],
      );
      expect(constraint.rows[0].n, 'committed constraint row must exist').toBe(1);
      const audit = await c.query(
        `SELECT count(*)::int AS n FROM choros.audit_event
           WHERE tenant_id = $1 AND subject = $2 AND type = 'sod.create'`,
        [TENANT_A, newId],
      );
      expect(audit.rows[0].n, 'paired sod.create audit_event must exist').toBe(1);
      // Cleanup the constraint row (audit_event is append-only — leave it).
      await c.query(`DELETE FROM choros.sod_constraint WHERE id = $1`, [newId]);
    });
  });
});

// ---------------------------------------------------------------------------
// A5 — update/delete on a non-existent id is a clean no-op (no existence leak)
// ---------------------------------------------------------------------------
describe('Враг · SoD write — non-existent id is not-found, not an oracle', () => {
  it('A5: updateSodConstraintInTx / deleteSodConstraintInTx on an unknown id return found=false', async () => {
    const ghostId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query('SET LOCAL search_path TO choros');
      const upd = await updateSodConstraintInTx(c as unknown as SodTxClient, TENANT_A, ghostId, {
        selfRecord: false,
      });
      expect(upd.found, 'update of unknown id → found=false (404, no leak)').toBe(false);
      const del = await deleteSodConstraintInTx(c as unknown as SodTxClient, TENANT_A, ghostId);
      expect(del.found, 'delete of unknown id → found=false (404, no leak)').toBe(false);
      await c.query('ROLLBACK');
    });
  });
});
