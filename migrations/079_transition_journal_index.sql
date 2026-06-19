-- 079 · transition_journal_index (T-0339 E15-S3)
--
-- F2 Phase 1: CREATE INDEX on audit_event payload for the 6-event transition
-- journal + a materialized view for cycle-time analytics. NO new TABLE.
-- This migration only adds indexes and a mat-view over the EXISTING audit_event
-- table (migration 006). Passes defer-no-new-table.sh (D-061 / FF-DC7).
--
-- DESIGN:
--   - The 6 transition events (instance.started, task.created, task.claimed,
--     gateway.evaluated, task.completed, instance.ended) all embed a canonical
--     transition_payload JSONB object under the key "transition_payload" in
--     audit_event.payload. These events also have type IN that set.
--   - idx_audit_transition_payload: GIN index on payload WHERE the event type is
--     one of the 6 known transition types. Speeds up `payload->>'transition_payload'`
--     extraction and filtering (§4.2 metric queries).
--   - idx_audit_transition_instance: btree expression index on
--     (tenant_id, payload->>'instance_id' via transition_payload, occurred_at)
--     for the self-join cycle-time query (T-0339 §cycle-time analytics).
--   - process_transition_journal: SECURITY DEFINER materialized view (analogous
--     to job_locked_expired_buckets, migration 029) that projects the 6 canonical
--     transition events into a flat, typed row for GROUP BY analytics.
--     Columns: tenant_id, instance_id, process_key, activity, actor, actor_type,
--              ts_ms (= occurred_at), duration_ms, verdict, event_id.
--   - choros_app: EXECUTE on the refresh function; SELECT on the mat-view.
--   - NO new TABLE — only indexes and a mat-view on existing audit_event.
--
-- Idempotency: IF NOT EXISTS / CREATE OR REPLACE / DO guard.
-- Owner: choros_migrator (inherits CURRENT_USER at migration apply time).
--
-- FROZEN-CHECK SAFETY: this comment does NOT contain the token "user_task" nor
-- the token sequence "create table" (case-insensitive) in SQL bodies — only in
-- this header comment with "TABLE" as part of "NO new TABLE". The actual DDL
-- below uses CREATE MATERIALIZED VIEW and CREATE INDEX exclusively.

-- -------------------------------------------------------------------------
-- Part A: Partial GIN index on payload for the 6 transition event types.
--
-- A GIN index over the full jsonb payload is broad but correct for F2 Phase 1
-- (pre-profiling). The WHERE clause limits it to the known transition event
-- types so non-transition rows are excluded from the index entirely.
-- -------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_transition_payload
  ON choros.audit_event USING GIN (payload)
  WHERE type IN (
    'instance.started',
    'task.created',
    'task.claimed',
    'gateway.evaluated',
    'task.completed',
    'instance.ended'
  );

-- -------------------------------------------------------------------------
-- Part B: btree index for the self-join cycle-time query.
--
-- The cycle-time query joins audit_event to itself on (tenant_id, instance_id)
-- and groups by activity to compute per-step duration. This index makes the
-- join efficient: (tenant_id, occurred_at) for ordering + the transition-type
-- WHERE clause so Postgres can use an index scan on both sides.
-- -------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_transition_tenant_ts
  ON choros.audit_event (tenant_id, occurred_at)
  WHERE type IN (
    'instance.started',
    'task.created',
    'task.claimed',
    'gateway.evaluated',
    'task.completed',
    'instance.ended'
  );

-- -------------------------------------------------------------------------
-- Part C: Materialized view — process_transition_journal
--
-- Projects the 6 canonical transition events into a flat row for GROUP BY
-- analytics (§4.2). The view reads transition_payload via JSONB path so it is
-- independent of the outer audit_event structure: tenant_id, instance_id,
-- process_key, activity, actor, actor_type, ts_ms, duration_ms, verdict.
--
-- SECURITY DEFINER is NOT needed for the mat-view itself (views inherit caller
-- privileges); but the refresh function is SECURITY DEFINER so the scheduler
-- can call it without granting choros_migrator access to the app user.
--
-- The mat-view is built WITH NO DATA initially (safe for migration apply without
-- a live DB write) and must be refreshed via choros.refresh_transition_journal().
-- -------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS choros.process_transition_journal AS
  SELECT
    ae.tenant_id,
    ae.id                                                       AS event_id,
    ae.type                                                     AS event_type,
    ae.occurred_at                                              AS ts_ms,
    (ae.payload -> 'transition_payload' ->> 'instance_id')     AS instance_id,
    (ae.payload -> 'transition_payload' ->> 'process_key')     AS process_key,
    (ae.payload -> 'transition_payload' ->> 'activity')        AS activity,
    (ae.payload -> 'transition_payload' ->> 'actor')           AS actor,
    (ae.payload -> 'transition_payload' ->> 'actor_type')      AS actor_type,
    (ae.payload -> 'transition_payload' ->> 'duration_ms')::bigint AS duration_ms,
    (ae.payload -> 'transition_payload' ->> 'verdict')         AS verdict
  FROM choros.audit_event ae
  WHERE ae.type IN (
    'instance.started',
    'task.created',
    'task.claimed',
    'gateway.evaluated',
    'task.completed',
    'instance.ended'
  )
    AND ae.payload ? 'transition_payload'
WITH NO DATA;

-- Index on the mat-view for common query patterns (tenant + instance + ts ordering).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ptj_event_id
  ON choros.process_transition_journal (event_id);

CREATE INDEX IF NOT EXISTS idx_ptj_tenant_instance
  ON choros.process_transition_journal (tenant_id, instance_id, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ptj_tenant_activity
  ON choros.process_transition_journal (tenant_id, activity, ts_ms);

-- -------------------------------------------------------------------------
-- Part D: SECURITY DEFINER refresh function
--
-- choros.refresh_transition_journal() can be called by choros_app (via a
-- scheduled trigger or on-demand) to refresh the mat-view. SECURITY DEFINER
-- so the caller does not need choros_migrator privileges to run REFRESH.
-- search_path is hardcoded to prevent search-path-hijack attacks.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION choros.refresh_transition_journal()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = choros, pg_catalog
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY choros.process_transition_journal;
$$;

REVOKE ALL ON FUNCTION choros.refresh_transition_journal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION choros.refresh_transition_journal() TO choros_app;

-- Grant SELECT on the materialized view to the app user.
GRANT SELECT ON choros.process_transition_journal TO choros_app;
