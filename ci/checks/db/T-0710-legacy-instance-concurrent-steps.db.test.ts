// ci/checks/db/T-0710-legacy-instance-concurrent-steps.db.test.ts
//
// T-0710 [E16, capstone T-0691 P2, bug #1] — live-DB probe for the
// "instance-detail «Текущий шаг» lists TWO steps for a legacy instance" defect.
//
// THE BUG (found live, T-0709/T-0691 LIVE_PROOF, instance 99573238): a legacy /
// malformed audit trail — a process.started base row whose OWN task.approved was
// never recorded, sitting alongside a process.next_task row for the SAME instance
// (real emit sites only append a next_task after confirming, via a LIVE engine
// call, that the token already moved past the base step — see the T-0608 doc
// comment on listInstanceInboxTasks) — made listInstanceProjections's
// concurrentSteps fold list BOTH the stale base step and the real next step as if
// they were concurrent AND-split branches. They are SEQUENTIAL: the base step was
// superseded, its own task.approved audit event simply never landed. The
// instance-detail screen (nodes.length > 1) then rendered two "concurrent branch"
// rows for a token that only ever sits on ONE node at a time.
//
// THE FIX: listInstanceProjections now tracks "instancesWithAnyNextTask" (mirrors
// the T-0608 rule already proven in listInstanceInboxTasks) — the mere existence
// of ANY next_task row (approved or pending) for an instance proves the base step
// is superseded, independent of whether the base's own task.approved landed. The
// base step is then excluded from concurrentSteps, and the primary step/role
// follow concurrentSteps[0] (keeping the step===concurrentSteps[0] invariant the
// catalog/detail/inbox read planes rely on — T-0709/T-0718 single source of
// truth).
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db -- T-0710-legacy-instance-concurrent-steps

import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { appUrl } from './_helpers.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';
import {
  appendProcessStarted,
  appendNextTaskEvent,
  appendTaskApproved,
  listInstanceProjections,
} from '../../../src/http/process-projection.js';

const { Client } = pg;

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

const hasDb = Boolean(process.env['DATABASE_URL']);
const PROC_KEY = 'proc-t0710-fixture';

// Neutral test-fixture labels — anti-case-excluded (this is a .test.ts file), never
// a real persona/role literal from src/. Mirrors process-catalog-live-step.test.ts's
// SNAPSHOT_STEP/LIVE_STEP convention.
const BASE_STEP = 'step-base-legacy';
const BASE_ROLE = 'role-base-legacy';
const NEXT_STEP = 'step-next-real';
const NEXT_ROLE = 'role-next-real';

describe('T-0710 bug #1 — listInstanceProjections: legacy instance reports ONE active node, not two', () => {
  it('instance 99573238 (documented live repro id): base row missing task.approved + a pending next_task → concurrentSteps is [NEXT_STEP] only', async () => {
    if (!hasDb) return;
    const tenantId = freshTenant();
    // T-0710: uses the EXACT instance id named in the live-proof plan/finding
    // (docs/live-proof/T-0709.md "смежная находка") for direct traceability — a
    // test-fixture literal, not a src/ hardcode.
    const instanceId = '99573238';
    const t0 = Date.now();

    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: t0,
        approverRole: BASE_ROLE,
        step: BASE_STEP,
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // The base step's OWN task.approved is deliberately NEVER emitted — the
      // legacy/malformed-trail shape. A next_task row for the SAME instance is
      // appended instead (exactly what every real emit site does only AFTER
      // confirming, live, that the engine already moved past the base step).
      await appendNextTaskEvent(pool, tenantId, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'system:t0710-fixture',
        nowMs: t0 + 1_000,
        taskDefKey: 'task-next-t0710',
        taskName: 'T-0710 fixture next task',
        taskRole: NEXT_ROLE,
        taskStep: NEXT_STEP,
        inboxTaskId: crypto.randomUUID(),
      });

      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj).toBeDefined();

      // THE FIX: exactly ONE active node — the real (next) step, not the stale base.
      expect(proj!.concurrentSteps).toEqual([NEXT_STEP]);
      // Primary step/role follow the same fix (single source of truth with
      // concurrentSteps[0] — otherwise the catalog/inbox-drawer single-step
      // surfaces would still show the stale base step while the detail page's
      // nodes[] correctly showed only the next step, reintroducing a T-0709-class
      // divergence between read surfaces).
      expect(proj!.step).toBe(NEXT_STEP);
      expect(proj!.role).toBe(NEXT_ROLE);
      expect(proj!.status).toBe('waiting');
    } finally {
      await pool.end();
    }
  });

  it('regression: a genuinely single-step waiting instance (no next_task at all) still reports its own base step, unchanged', async () => {
    if (!hasDb) return;
    const tenantId = freshTenant();
    const instanceId = crypto.randomUUID();
    const t0 = Date.now();

    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: t0,
        approverRole: BASE_ROLE,
        step: BASE_STEP,
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj).toBeDefined();
      expect(proj!.concurrentSteps).toEqual([BASE_STEP]);
      expect(proj!.step).toBe(BASE_STEP);
      expect(proj!.role).toBe(BASE_ROLE);
    } finally {
      await pool.end();
    }
  });

  it('regression: a CORRECTLY-audited post-gateway instance (base task.approved present + pending next_task) is unaffected — still ONE active node', async () => {
    if (!hasDb) return;
    const tenantId = freshTenant();
    const instanceId = crypto.randomUUID();
    const t0 = Date.now();

    const taskId = await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: t0,
        approverRole: BASE_ROLE,
        step: BASE_STEP,
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      await withTenantTx(tenantId, (tx) =>
        appendTaskApproved(tx, {
          taskId,
          instanceId,
          procKey: PROC_KEY,
          actor: 'e-t0710-approver',
          nowMs: t0 + 500,
          tenantId,
        }),
      );
      await appendNextTaskEvent(pool, tenantId, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'system:t0710-fixture',
        nowMs: t0 + 1_000,
        taskDefKey: 'task-next-t0710-b',
        taskName: 'T-0710 fixture next task (correctly audited)',
        taskRole: NEXT_ROLE,
        taskStep: NEXT_STEP,
        inboxTaskId: crypto.randomUUID(),
      });

      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj).toBeDefined();
      // Was already correct before T-0710 (baseApproved excludes the base step on
      // its own) — this proves the fix did not disturb the already-correct path.
      expect(proj!.concurrentSteps).toEqual([NEXT_STEP]);
      expect(proj!.step).toBe(NEXT_STEP);
    } finally {
      await pool.end();
    }
  });
});
