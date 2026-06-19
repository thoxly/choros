-- 078 · user_task_claim (T-0338 E15-S2) — TOCTOU-safe human-claim lock primitive.
--
-- This table is the DB-level lock for the human-claim-from-pool path (F3).
-- It is a PROJECTION (lock primitive + current snapshot), NOT the source of
-- history — history stays in the append-only audit_event (task.claimed events,
-- migration 006). The table is rebuildable from audit_event at any time.
--
-- DESIGN (spec §3 S2 / §4.1):
--   Human claim = choros-owned. A row exists while a task is in state='claimed'.
--   The partial-unique index (tenant_id, task_id) WHERE state='claimed' is the
--   hard lock: a second concurrent INSERT for the same (tenant_id, task_id) in
--   state='claimed' hits the unique violation → fails atomically at the DB.
--   This closes the TOCTOU window that existed between the audit read-check and
--   the task.claimed emit in T-0336.
--
--   One claim-tx does ALL three in the SAME tenant-RLS tx:
--     1. Grant-check (resolveRolesForActor — getGrantsForSubject path).
--     2. INSERT into user_task_claim (this table → hard lock).
--     3. Emit task.claimed audit event (appendTaskClaimed).
--   If any step fails the whole tx rolls back → no half-state.
--
--   Agent/service claims are Flowable-owned (fetchAndLock) — NOT here.
--
-- Tenant-table contract (T-0013 / migration 006 pattern):
--   tenant_id-leading PK, ENABLE+FORCE ROW LEVEL SECURITY, exactly ONE isolation
--   predicate current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   GRANT SELECT,INSERT,UPDATE,DELETE ... TO choros_app,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + DO-guard on policy + CREATE INDEX IF NOT EXISTS.
--   schema_migrations tracks runs; repeating this file is safe (NF-1).

CREATE TABLE IF NOT EXISTS choros.user_task_claim (
  tenant_id   uuid    NOT NULL,
  task_id     text    NOT NULL,
  claimed_by  text    NOT NULL,
  claimed_at  bigint  NOT NULL,
  role        text    NOT NULL,
  state       text    NOT NULL DEFAULT 'claimed'
    CHECK (state IN ('claimed', 'released')),

  PRIMARY KEY (tenant_id, task_id)
);

-- Hard lock: at most one row per (tenant_id, task_id) may be in state='claimed'.
-- A concurrent INSERT with the same (tenant_id, task_id, state='claimed') fails
-- immediately at the DB — zero TOCTOU window.
CREATE UNIQUE INDEX IF NOT EXISTS user_task_claim_lock
  ON choros.user_task_claim (tenant_id, task_id)
  WHERE state = 'claimed';

ALTER TABLE choros.user_task_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.user_task_claim FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'user_task_claim'
      AND policyname = 'user_task_claim_tenant_isolation'
  ) THEN
    CREATE POLICY user_task_claim_tenant_isolation ON choros.user_task_claim
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.user_task_claim TO choros_app;
