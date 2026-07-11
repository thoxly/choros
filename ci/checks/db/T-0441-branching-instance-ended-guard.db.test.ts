// ci/checks/db/T-0441-branching-instance-ended-guard.db.test.ts
//
// T-0441 [substrate, changes_product=0, analytics] — surfaced by T-0440 review
// (observation #8). Live-Postgres proof that a BRANCHING process instance's
// approve of an INTERMEDIATE step does NOT write a PHANTOM `instance.ended`
// transition-journal event before the engine has actually ended the instance.
//
// THE BUG (as described in the T-0440 review): the post-approve engine-drive
// wrote `instance.ended` right after completing the approved user-task, WITHOUT
// checking whether the engine reports the instance as still alive. A branching
// process's FIRST approve (base step -> DMN gateway -> a second "6M"-style
// extra-approve step) would then write a PHANTOM `instance.ended` row — the
// `process_transition_journal` / cycle-time analytics (loadInstanceJournal,
// loadCycleTimeByActivity — src/db/transition-journal.ts) would count a
// completion that never happened.
//
// THE GUARD (src/http/process-projection.ts, reconcileInstanceEngineDrive):
// `instance.ended` is emitted from EXACTLY ONE call site (appendInstanceEnded),
// reached ONLY when `engine.isInstanceEnded(instanceId)` reports true. The
// "not really ended" signal named by the task is exactly this: a live
// post-gateway `process.next_task` step exists / `!isInstanceEnded`. This test
// is the missing REAL-Postgres proof of that guard — the existing coverage
// (src/__tests__/inbox-engine-drive.test.ts, "8b"/"8c") drives the SAME
// reconcile function but against an in-memory fake pool, never real SQL/JSONB
// extraction against choros.audit_event / the transition-journal reader.
//
// MUTATION-PROOF (performed manually during T-0441 verification, not committed):
// temporarily forcing the `if (endedResult.ended)` branch in
// reconcileInstanceEngineDrive to `if (true)` makes this file's first test RED
// (a phantom instance.ended row appears after the intermediate approve, before
// the engine ever reports the instance ended). Reverting the mutation makes it
// GREEN again.
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//      npm run fitness:db -- T-0441-branching-instance-ended-guard

import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { appUrl } from './_helpers.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';
import {
  appendProcessStarted,
  appendTaskApproved,
  reconcileInstanceEngineDrive,
  INSTANCE_ENDED_TYPE,
  type EngineDriveReconcilePort,
} from '../../../src/http/process-projection.js';
import { loadInstanceJournal, loadCycleTimeByActivity } from '../../../src/db/transition-journal.js';

const { Client } = pg;
const hasDb = Boolean(process.env['DATABASE_URL']);

function freshTenant(): string {
  return crypto.randomUUID();
}

/** BEGIN a tx on an appUrl() connection, SET LOCAL tenant GUC, run fn, COMMIT. */
async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: PgClientLike) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');
    const result = await fn(c as unknown as PgClientLike);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/** Count raw `instance.ended` audit_event rows for one instance — real SQL, RLS-scoped. */
async function countInstanceEndedRows(tenantId: string, instanceId: string): Promise<number> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');
    const { rows } = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM choros.audit_event
        WHERE tenant_id = $1 AND type = $2 AND payload ->> 'inst' = $3`,
      [tenantId, INSTANCE_ENDED_TYPE, instanceId],
    );
    await c.query('COMMIT');
    return parseInt(rows[0]?.n ?? '0', 10);
  } finally {
    await c.end();
  }
}

/**
 * A fake engine port simulating a BRANCHING (DMN-gateway) process:
 *   phase 'base'  -> active task = task-approve (the base/intermediate step).
 *   phase 'extra' -> base completed, gateway routed to task-extra-approve (the
 *                    6M-style branch); isInstanceEnded=false — a live
 *                    process.next_task step exists (the "not really ended" signal).
 *   phase 'ended' -> extra-approve completed; the engine now genuinely reports end.
 */
function makeBranchingEngine(instanceId: string): { engine: EngineDriveReconcilePort } {
  const state: { phase: 'base' | 'extra' | 'ended' } = { phase: 'base' };
  const engine: EngineDriveReconcilePort = {
    async getActiveUserTasks(inst) {
      if (inst !== instanceId) return { ok: true, tasks: [] };
      if (state.phase === 'base') {
        return {
          ok: true,
          tasks: [
            { id: 'eng-task-base', taskDefinitionKey: 'task-approve', name: 'Base approve', candidateGroups: ['role-approver'] },
          ],
        };
      }
      if (state.phase === 'extra') {
        return {
          ok: true,
          tasks: [
            { id: 'eng-task-extra', taskDefinitionKey: 'task-extra-approve', name: 'Extra approve (6M)', candidateGroups: ['role-cfo'] },
          ],
        };
      }
      return { ok: true, tasks: [] };
    },
    async completeUserTask(engineTaskId) {
      if (engineTaskId === 'eng-task-base' && state.phase === 'base') {
        state.phase = 'extra'; // DMN gateway routed to the extra-approve branch — NOT ended.
        return { ok: true };
      }
      if (engineTaskId === 'eng-task-extra' && state.phase === 'extra') {
        state.phase = 'ended'; // genuine final completion.
        return { ok: true };
      }
      return { ok: false, code: 'NOT_FOUND' };
    },
    async isInstanceEnded(inst) {
      if (inst !== instanceId) return { ok: true, ended: false };
      return { ok: true, ended: state.phase === 'ended' };
    },
  };
  return { engine };
}

describe.skipIf(!hasDb)(
  'T-0441 — branching process: approve of the intermediate step does not write a phantom instance.ended (real Postgres)',
  () => {
    it('base-step approve (branching, gateway -> extra-approve): NO instance.ended row; final approve: exactly ONE, analytics undistorted', async () => {
      const tenantId = freshTenant();
      const instanceId = `flw-t0441-${crypto.randomUUID().slice(0, 8)}`;
      const procKey = `branchingProc-${crypto.randomUUID().slice(0, 8)}`;
      const t0 = Date.now();

      const { engine } = makeBranchingEngine(instanceId);
      const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
      try {
        const baseTaskId = await withTenantTx(tenantId, (tx) =>
          appendProcessStarted(tx, {
            instanceId,
            procKey,
            actor: 'e-t0441-initiator',
            nowMs: t0,
            approverRole: 'role-approver',
            step: 'task-approve',
            tenantId,
          }),
        );

        // --- Approve #1: the BASE (intermediate) step of a branching process. ---
        await withTenantTx(tenantId, (tx) =>
          appendTaskApproved(tx, {
            taskId: baseTaskId,
            instanceId,
            procKey,
            actor: 'e-t0441-approver-1',
            nowMs: t0 + 1_000,
            tenantId,
          }),
        );
        const driveResult1 = await reconcileInstanceEngineDrive(pool, tenantId, engine, {
          instanceId,
          procKey,
          completeEngineTask: true, // base step: resolve-by-instance (approvedTaskDefKey omitted).
          actor: 'e-t0441-approver-1',
          nowMs: t0 + 1_000,
        });
        expect(driveResult1.ok).toBe(true);
        if (driveResult1.ok) {
          expect(driveResult1.ended).toBe(false); // gateway routed onward — NOT ended.
          expect(driveResult1.emitted).toBe(1); // process.next_task(task-extra-approve) surfaced.
        }

        // THE PROOF (mutation-target #1): no instance.ended row yet — the engine has
        // more tokens (a live process.next_task / !isInstanceEnded), so approve#1
        // must not have emitted the phantom completion.
        expect(await countInstanceEndedRows(tenantId, instanceId)).toBe(0);

        const journalAfterStep1 = await loadInstanceJournal(pool, tenantId, instanceId);
        expect(journalAfterStep1.some((e) => e.event_type === INSTANCE_ENDED_TYPE)).toBe(false);

        // --- Approve #2: the extra-approve (6M) step — the GENUINE final step. ---
        await withTenantTx(tenantId, (tx) =>
          appendTaskApproved(tx, {
            taskId: crypto.randomUUID(),
            instanceId,
            procKey,
            actor: 'e-t0441-approver-2',
            nowMs: t0 + 2_000,
            tenantId,
          }),
        );
        const driveResult2 = await reconcileInstanceEngineDrive(pool, tenantId, engine, {
          instanceId,
          procKey,
          approvedTaskDefKey: 'task-extra-approve',
          completeEngineTask: true,
          actor: 'e-t0441-approver-2',
          nowMs: t0 + 2_000,
        });
        expect(driveResult2.ok).toBe(true);
        if (driveResult2.ok) {
          expect(driveResult2.ended).toBe(true); // engine now genuinely confirms end.
        }

        // THE PROOF (mutation-target #2): exactly ONE instance.ended row — the real
        // final completion, never a duplicate/phantom.
        expect(await countInstanceEndedRows(tenantId, instanceId)).toBe(1);

        const journalAfterStep2 = await loadInstanceJournal(pool, tenantId, instanceId);
        const endedEvents = journalAfterStep2.filter((e) => e.event_type === INSTANCE_ENDED_TYPE);
        expect(endedEvents).toHaveLength(1);
        // instance.ended is the LAST event chronologically — it never precedes the real end.
        expect(journalAfterStep2[journalAfterStep2.length - 1]!.event_type).toBe(INSTANCE_ENDED_TYPE);

        // Cycle-time analytics (loadCycleTimeByActivity) are not distorted by a
        // phantom second instance.ended: the activity count for this proc's
        // instance.ended is exactly 1, not 2.
        const analytics = await loadCycleTimeByActivity(pool, tenantId, procKey);
        const endedActivity = analytics.rows.find((r) => r.activity === INSTANCE_ENDED_TYPE);
        expect(endedActivity).toBeDefined();
        expect(endedActivity!.count).toBe(1);

        // Idempotent re-run (reconcile-on-read mirror mode): driving the ALREADY-ended
        // instance again does not pile up a second instance.ended row.
        const driveResult3 = await reconcileInstanceEngineDrive(pool, tenantId, engine, {
          instanceId,
          procKey,
          completeEngineTask: false,
          actor: 'system:reconcile-on-read',
          nowMs: t0 + 3_000,
        });
        expect(driveResult3.ok).toBe(true);
        expect(await countInstanceEndedRows(tenantId, instanceId)).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it('regression: a LINEAR (non-branching) process still writes exactly one instance.ended on its single approve', async () => {
      const tenantId = freshTenant();
      const instanceId = `flw-t0441-linear-${crypto.randomUUID().slice(0, 8)}`;
      const procKey = `linearProc-${crypto.randomUUID().slice(0, 8)}`;
      const t0 = Date.now();

      // A trivial one-step engine: completing the base task genuinely ends the instance.
      let ended = false;
      const engine: EngineDriveReconcilePort = {
        async getActiveUserTasks(inst) {
          if (inst !== instanceId) return { ok: true, tasks: [] };
          return {
            ok: true,
            tasks: [{ id: 'eng-task-linear', taskDefinitionKey: 'task-approve', name: 'Approve', candidateGroups: ['role-approver'] }],
          };
        },
        async completeUserTask() {
          ended = true;
          return { ok: true };
        },
        async isInstanceEnded(inst) {
          if (inst !== instanceId) return { ok: true, ended: false };
          return { ok: true, ended };
        },
      };

      const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
      try {
        const taskId = await withTenantTx(tenantId, (tx) =>
          appendProcessStarted(tx, { instanceId, procKey, actor: 'e-t0441-lin', nowMs: t0, tenantId }),
        );
        await withTenantTx(tenantId, (tx) =>
          appendTaskApproved(tx, { taskId, instanceId, procKey, actor: 'e-t0441-lin-approver', nowMs: t0 + 500, tenantId }),
        );
        const result = await reconcileInstanceEngineDrive(pool, tenantId, engine, {
          instanceId,
          procKey,
          completeEngineTask: true,
          actor: 'e-t0441-lin-approver',
          nowMs: t0 + 500,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.ended).toBe(true);
        expect(await countInstanceEndedRows(tenantId, instanceId)).toBe(1);
      } finally {
        await pool.end();
      }
    });
  },
);
