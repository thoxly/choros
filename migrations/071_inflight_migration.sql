-- 071 · in-flight migration (T-0086) — drain-by-default + rollback guard seam
--
-- ADR: docs/design/extensibility-and-authoring.md §7 / §9.6
-- Spec: T-0086 · E12.5 in-flight migration
--
-- Builds on T-0085 (migration 070) schema-version model:
--   - bundle_version_instance: tracks live process instances pinned to a
--     bundle content_hash (drain-by-default state store).
--   - inflight_mapping_request: records red-line-gated Camunda-style
--     in-flight instance mapping requests (on-demand escalation, NOT default).
--   - fn_count_live_instances_above_version: companion to T-0085's
--     fn_check_rollback_safe — counts live instances that block a rollback.
--
-- Design:
--   DRAIN-by-default: new rows in bundle_version_instance with state='draining'
--   represent the safe default. Instances complete on their pinned version.
--   No forced migration occurs.
--
--   Rollback guard: guardRollback (TypeScript) calls fn_check_rollback_safe
--   (migration 070) AND fn_count_live_instances_above_version (this migration)
--   via the injected RollbackSafePort. Both must pass for rollback to be allowed.
--
--   Camunda mapping = escalation: inflight_mapping_request stores the gated
--   request. State 'pending_approval' ensures no auto-execution; only
--   'approved' → 'executed' after explicit human-gate confirmation.
--
-- Additive: does NOT alter existing tables. Adds two new tenant tables.
-- Sister migration (072) may follow; must not use 071 or lower.

-- ============================================================
-- Table 1: bundle_version_instance
--
-- Tracks live process instances pinned to a specific bundle content_hash.
-- This is the drain-by-default state store (ADR §7 "DRAIN-by-default").
--
-- PK: (tenant_id, process_instance_id) — one pin per instance.
-- FK: bundle_id is a logical reference to the bundle (no FK to bundle_commit
--     to avoid cross-table coupling across migration owners).
--
-- Full RLS: NF-1 single predicate, FORCE, GRANT choros_app, composite PK.
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.bundle_version_instance (
  tenant_id             uuid    NOT NULL,
  process_instance_id   text    NOT NULL,
  bundle_id             text    NOT NULL,
  pinned_content_hash   text    NOT NULL,
  pinned_at             bigint  NOT NULL,
  state                 text    NOT NULL DEFAULT 'draining',

  PRIMARY KEY (tenant_id, process_instance_id),

  CONSTRAINT bundle_version_instance_state_check
    CHECK (state IN ('draining', 'completed')),

  CONSTRAINT bundle_version_instance_content_hash_len
    CHECK (char_length(pinned_content_hash) = 64),

  CONSTRAINT bundle_version_instance_bundle_id_nonempty
    CHECK (char_length(bundle_id) > 0),

  CONSTRAINT bundle_version_instance_instance_id_nonempty
    CHECK (char_length(process_instance_id) > 0)
);

ALTER TABLE choros.bundle_version_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.bundle_version_instance FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'bundle_version_instance'
      AND policyname = 'bundle_version_instance_tenant_isolation'
  ) THEN
    EXECUTE $p$
      CREATE POLICY bundle_version_instance_tenant_isolation
        ON choros.bundle_version_instance
        USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid)
    $p$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON choros.bundle_version_instance TO choros_app;

-- Index for rollback-guard drain count query:
--   countLiveInstancesAboveVersion searches by (tenant_id, bundle_id, state='draining')
CREATE INDEX IF NOT EXISTS idx_bvi_tenant_bundle_state
  ON choros.bundle_version_instance (tenant_id, bundle_id, state);

-- ============================================================
-- Table 2: inflight_mapping_request
--
-- Records red-line-gated Camunda-style in-flight instance migration
-- mapping requests. State machine: pending_approval → approved → executed
-- (or rejected). This is the on-demand escalation path (ADR §7
-- "on-demand ЭСКАЛАЦИЯ внутри red-lines, не дефолт").
--
-- A 'pending_approval' state enforces that execution never happens
-- automatically — human-gate is required to advance to 'approved'.
--
-- Full RLS: NF-1 single predicate, FORCE, GRANT choros_app, composite PK.
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.inflight_mapping_request (
  tenant_id             uuid    NOT NULL,
  id                    uuid    NOT NULL,
  process_instance_id   text    NOT NULL,
  from_content_hash     text    NOT NULL,
  to_content_hash       text    NOT NULL,
  from_activity_id      text    NOT NULL,
  from_activity_kind    text    NOT NULL,
  to_activity_id        text    NOT NULL,
  to_activity_kind      text    NOT NULL,
  auto_map_matching_ids boolean NOT NULL DEFAULT false,
  requested_by          text    NOT NULL,
  requested_at          bigint  NOT NULL,
  state                 text    NOT NULL DEFAULT 'pending_approval',
  approved_by           text,
  approved_at           bigint,
  executed_at           bigint,
  rejection_reason      text,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT inflight_mapping_state_check
    CHECK (state IN ('pending_approval', 'approved', 'executed', 'rejected')),

  CONSTRAINT inflight_mapping_kind_check
    CHECK (from_activity_kind IN (
      'userTask', 'receiveTask', 'intermediateCatchEvent', 'callActivity'
    )),

  CONSTRAINT inflight_mapping_to_kind_check
    CHECK (to_activity_kind IN (
      'userTask', 'receiveTask', 'intermediateCatchEvent', 'callActivity'
    )),

  CONSTRAINT inflight_mapping_kind_consistent
    CHECK (from_activity_kind = to_activity_kind),

  CONSTRAINT inflight_mapping_from_hash_len
    CHECK (char_length(from_content_hash) = 64),

  CONSTRAINT inflight_mapping_to_hash_len
    CHECK (char_length(to_content_hash) = 64),

  CONSTRAINT inflight_mapping_hashes_differ
    CHECK (from_content_hash <> to_content_hash),

  CONSTRAINT inflight_mapping_requested_by_nonempty
    CHECK (char_length(requested_by) > 0),

  CONSTRAINT inflight_mapping_instance_id_nonempty
    CHECK (char_length(process_instance_id) > 0)
);

ALTER TABLE choros.inflight_mapping_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.inflight_mapping_request FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'inflight_mapping_request'
      AND policyname = 'inflight_mapping_request_tenant_isolation'
  ) THEN
    EXECUTE $p$
      CREATE POLICY inflight_mapping_request_tenant_isolation
        ON choros.inflight_mapping_request
        USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid)
    $p$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON choros.inflight_mapping_request TO choros_app;

-- ============================================================
-- SQL Function: fn_count_live_instances_above_version
--
-- Companion to T-0085's fn_check_rollback_safe.
-- Counts live (state='draining') process instances in bundle_version_instance
-- that are NOT on the target bundle version (i.e., cannot be reached by
-- rolling back to target_version).
--
-- Used by the RollbackSafePort adapter to provide actionable diagnostics
-- when guardRollback blocks a rollback.
--
-- Parameters:
--   p_tenant_id      UUID of the tenant
--   p_bundle_id      The bundle being rolled back
--   p_target_version The schema version target for rollback (integer)
--
-- NOTE: bundle_version_instance tracks instances by content_hash (string),
-- not by integer version. The count of "above version" instances is
-- equivalent to "any draining instances on this bundle" — because rollback
-- means publishing a new commit hash, and any draining instance is pinned
-- to a hash that will be ahead of the rollback target.
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_count_live_instances_above_version(
  p_tenant_id     uuid,
  p_bundle_id     text,
  p_target_version integer
)
RETURNS integer AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*)::integer INTO v_count
    FROM choros.bundle_version_instance
   WHERE tenant_id = p_tenant_id
     AND bundle_id = p_bundle_id
     AND state = 'draining';

  RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql;
