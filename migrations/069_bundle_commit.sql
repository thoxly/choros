-- 069 · bundle_commit + bundle_ref (T-0083 · E12.2) — content-addressed bundle versioning.
--
-- ADR: docs/design/extensibility-and-authoring.md §7 ("git-под-капотом")
-- Design: docs/design/T-0083.pr-handoff.json
-- Foundations: T-0082 (bundle coherence), T-0118 (hash-oracle seam), T-0013 (RLS-contract),
--              T-0017 (tenant-scoped FK discipline), T-0119 (migration discipline).
--
-- Two new tenant tables:
--   bundle_commit — content-addressed commit of a coherent bundle snapshot.
--                   Each row stores the five-member snapshot (object_schema, grants,
--                   bpmn_process, form_code, form_json_schema) plus the content_hash
--                   (SHA-256 of the canonical preimage), parent_hash (chaining),
--                   author, message, and committed_at (epoch-ms).
--   bundle_ref    — mutable named pointer to a bundle_commit (e.g. "HEAD" for the
--                   current published version). Upserted by `setRef`.
--
-- Tenant-table contract (T-0013, same as 061_doc_page.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- NF-1 invariant: RLS policy has ONLY the tenant_id predicate — NO bundle_id predicate.
--   Bundle isolation is enforced at the application layer (bundle_id in WHERE clauses),
--   not in RLS (which would need a second context variable violating NF-1).
--
-- Idempotency: CREATE TABLE IF NOT EXISTS; DO-guards on policies and indexes;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 069 (068 is owned by a sister task; this task is pre-assigned slot 069).

-- ---------------------------------------------------------------------------
-- bundle_commit — content-addressed commit of a coherent bundle snapshot
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.bundle_commit (
  tenant_id                 uuid    NOT NULL,
  -- The content address (SHA-256, 64 hex chars). Unique per tenant (collision = same snapshot).
  content_hash              text    NOT NULL,
  -- The bundle identifier this commit belongs to (e.g. a process_def_id or form_def_id).
  bundle_id                 text    NOT NULL,
  -- Parent commit hash; GENESIS_PARENT_HASH ('0' * 64) for the first commit.
  parent_hash               text    NOT NULL,
  -- Authoring actor string (e.g. agent actor or user id).
  author                    text    NOT NULL,
  -- Human-readable commit message.
  message                   text    NOT NULL DEFAULT '',
  -- Epoch-ms timestamp of commit creation (injected by caller, not DB default).
  committed_at              bigint  NOT NULL,
  -- The five-member bundle snapshot (mirrors BundleSnapshot interface).
  snapshot_object_schema    text    NOT NULL DEFAULT '',
  snapshot_grants           text    NOT NULL DEFAULT '',
  snapshot_bpmn_process     text    NOT NULL DEFAULT '',
  snapshot_form_code        text    NOT NULL DEFAULT '',
  snapshot_form_json_schema text    NOT NULL DEFAULT '',

  PRIMARY KEY (tenant_id, content_hash),

  -- bundle_id is part of the logical uniqueness; we index it for list queries.
  CONSTRAINT bundle_commit_hash_len_chk
    CHECK (char_length(content_hash) = 64)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
-- NF-1: single predicate — tenant_id only.
ALTER TABLE choros.bundle_commit ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.bundle_commit FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'bundle_commit'
      AND policyname = 'bundle_commit_tenant_isolation'
  ) THEN
    CREATE POLICY bundle_commit_tenant_isolation ON choros.bundle_commit
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.bundle_commit TO choros_app;

-- Index for list-commits-by-bundle queries (ORDER BY committed_at ASC).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'bundle_commit'
      AND indexname  = 'bundle_commit_tenant_bundle_at_idx'
  ) THEN
    CREATE INDEX bundle_commit_tenant_bundle_at_idx
      ON choros.bundle_commit (tenant_id, bundle_id, committed_at ASC);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- bundle_ref — mutable named pointer to a bundle_commit (e.g. "HEAD")
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.bundle_ref (
  tenant_id    uuid   NOT NULL,
  bundle_id    text   NOT NULL,
  ref_name     text   NOT NULL,
  -- Points to a bundle_commit.content_hash for this (tenant_id, bundle_id).
  content_hash text   NOT NULL,
  -- Last-updated epoch-ms (updated on each setRef upsert).
  updated_at   bigint NOT NULL,

  PRIMARY KEY (tenant_id, bundle_id, ref_name),

  CONSTRAINT bundle_ref_hash_len_chk
    CHECK (char_length(content_hash) = 64)
);

-- Row-level security: single tenant_id predicate (NF-1).
ALTER TABLE choros.bundle_ref ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.bundle_ref FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'bundle_ref'
      AND policyname = 'bundle_ref_tenant_isolation'
  ) THEN
    CREATE POLICY bundle_ref_tenant_isolation ON choros.bundle_ref
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.bundle_ref TO choros_app;
