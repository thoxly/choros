-- 109 · job.process_def_id + job.instance_id (T-0534) — per-process rule-table scope
--
-- Captures the Flowable processDefinitionKey and processInstanceId at fetchAndLock
-- time and stores them on choros.job so that evaluateGatewayAtTriage can scope
-- loadPublishedRuleTables to the exact process definition (procDefId), rather than
-- falling back to a NULL-union of all tenant-scoped tables.
--
-- Additive-safe: two nullable text columns — no DEFAULT expressions, no NOT NULL,
-- no index required for MVP (queue is tenant-scoped, rows are looked up by job id).
-- NULL = "process key not captured at enqueue time" → triage falls back to the
-- existing topic-keyed behaviour (safe, fail-closed).
--
-- RLS: choros.job inherits the existing job_tenant_isolation policy; these columns
-- participate under that policy automatically (no new policy needed).
--
-- Constraint: length cap mirrors idempotency_key pattern (≤255 chars) to prevent
-- pathologically-long engine-generated keys from bloating the table.
--
-- Idempotent: IF NOT EXISTS guards on both ADD COLUMN and ADD CONSTRAINT.

ALTER TABLE choros.job
  ADD COLUMN IF NOT EXISTS process_def_id text NULL,
  ADD COLUMN IF NOT EXISTS instance_id    text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_process_def_id_len'
  ) THEN
    ALTER TABLE choros.job ADD CONSTRAINT job_process_def_id_len
      CHECK (process_def_id IS NULL OR char_length(process_def_id) <= 255);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_instance_id_len'
  ) THEN
    ALTER TABLE choros.job ADD CONSTRAINT job_instance_id_len
      CHECK (instance_id IS NULL OR char_length(instance_id) <= 255);
  END IF;
END $$;
