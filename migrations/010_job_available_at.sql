-- 010 · job: available_at column + partial indexes (T-0114)
--
-- Additive migration: T-0053 already owns the full job table DDL.
-- This migration:
--   1. Adds available_at bigint NOT NULL DEFAULT 0
--   2. Back-fills available_at = created_at for any pre-existing rows
--   3. Creates two partial indexes for fetchAndLock performance (AC-12/NF-2)
--
-- tenant_id is the leading column in all composite indexes (T-0013 §3.1 invariant).
-- CONCURRENTLY is not used: migration runs as a single-phase operation on
-- an initially empty or small table (back-fill is offline-friendly). The migration
-- runner executes outside a multi-statement transaction (commits per file independently),
-- so blocking index creation is acceptable here.

ALTER TABLE choros.job
  ADD COLUMN IF NOT EXISTS available_at bigint NOT NULL DEFAULT 0;

-- Back-fill: any row that still has available_at=0 gets it set to created_at.
-- On a fresh DB this is a no-op (no rows yet). On a live DB it restores semantics.
UPDATE choros.job SET available_at = created_at WHERE available_at = 0;

-- Partial index 1: CREATED jobs available for fetchAndLock pickup.
-- Leading column: tenant_id (T-0013 §3.1).
CREATE INDEX IF NOT EXISTS idx_job_fetchable_created
  ON choros.job (tenant_id, topic, created_at)
  WHERE state = 'CREATED';

-- Partial index 2: LOCKED jobs that may have an expired lock (reclaim path).
-- Leading column: tenant_id (T-0013 §3.1).
CREATE INDEX IF NOT EXISTS idx_job_fetchable_locked
  ON choros.job (tenant_id, topic, created_at)
  WHERE state = 'LOCKED';
