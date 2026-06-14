-- 058 · files / attachments (T-0201 / T-0119) — per-tenant file↔record attachment model.
--
-- Implements docs/design/T-0119-files-attachments.adr.md §2.1/§2.2/§4.1/§4.2.
-- Two tenant tables of the core: `file` (logical attachment, owned by a record)
-- and `file_version` (immutable content version → an S3 object_key). The binary
-- lives ONLY in S3 (FF-NB) — NEVER in Postgres (no bytea / no base64-text column).
--
-- A file's permission is a DERIVED projection of its owner record's write-perms
-- (record-RBAC, T-0119 / T-0021). There is NO file ACL / visibility column here
-- (FF-NOACL): "who sees the file" == "who sees the record", computed by the same
-- PDP (T-0021). This migration adds NO authorization surface — only metadata.
--
-- Tenant-table contract (T-0013, verbatim as in 054_connector.sql):
--   tenant_id leading PK/FK, ENABLE+FORCE RLS, isolation policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT, listed in ci/checks/known_tenant_tables.txt.
--   Composite tenant-leading FKs ⇒ cross-tenant reference is structurally
--   impossible (T-0014).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies; runner
--   skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 058 (reserved for T-0201; 057/059 reserved for parallel siblings).

-- ===========================================================================
-- file — logical file-attachment (one record ↔ 0..N files)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS choros.file (
  tenant_id             uuid    NOT NULL,
  id                    uuid    NOT NULL,
  record_id             uuid    NOT NULL,   -- owner record (T-0014); FK below
  original_name         text    NOT NULL,   -- display name of the file
  current_version       uuid    NULL,       -- pointer to the active file_version.id
  retention_state       text    NOT NULL DEFAULT 'active'
    CHECK (retention_state IN ('active', 'archived', 'pending_deletion')),
  retention_policy_ref  text    NULL,       -- declarative policy (term/class); not hardcode
  created_by            text    NOT NULL,
  created_at            bigint  NOT NULL,
  updated_at            bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),
  -- Composite tenant-leading FK: the owner record must be of the SAME tenant —
  -- a cross-tenant attach is structurally unconstructible (T-0014).
  FOREIGN KEY (tenant_id, record_id)
    REFERENCES choros.record (tenant_id, id)
);

-- Listing files of a record (the common read path: "files on this card").
CREATE INDEX IF NOT EXISTS file_by_record
  ON choros.file (tenant_id, record_id);

ALTER TABLE choros.file ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.file FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros' AND tablename = 'file'
      AND policyname = 'file_tenant_isolation'
  ) THEN
    CREATE POLICY file_tenant_isolation ON choros.file
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.file TO choros_app;

-- ===========================================================================
-- file_version — immutable content version (→ one S3 object_key)
-- ===========================================================================
-- IMMUTABILITY (FF-V): a content version row is NEVER UPDATE/DELETE-d on its
-- content fields by the application. Replacing content = INSERT a new row +
-- repoint file.current_version. The only legitimate post-insert mutation is
-- setting content_erased_at (retention tombstone) — the metadata/hash survive.
--
-- NO binary column (FF-NB): the body lives in S3 under object_key. There is no
-- bytea / no large-object / no base64-text content column.
CREATE TABLE IF NOT EXISTS choros.file_version (
  tenant_id          uuid    NOT NULL,
  id                 uuid    NOT NULL,
  file_id            uuid    NOT NULL,
  version_no         integer NOT NULL,   -- monotonic per file
  object_key         text    NOT NULL,   -- S3 key "<tenant_id>/<file_id>/<version_id>"
  mime_type          text    NOT NULL,   -- declared MIME (from allowlist)
  size_bytes         bigint  NOT NULL,   -- size (<= declared limit)
  content_hash       text    NOT NULL,   -- content hash at upload (T-0118-compatible)
  data_class         text    NOT NULL DEFAULT 'internal'
    CHECK (data_class IN ('public', 'internal', 'confidential', 'restricted')),
  is_snapshot        boolean NOT NULL DEFAULT false,  -- document-on-demand snapshot (T-0124)
  cycle_ref          text    NULL,       -- trace to a rework-cycle event (nullable)
  content_erased_at  bigint  NULL,       -- retention tombstone: body erased, metadata lives (NF-5)
  uploaded_by        text    NOT NULL,
  uploaded_at        bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),
  -- Composite tenant-leading FK to the owning file (same tenant, structurally).
  FOREIGN KEY (tenant_id, file_id)
    REFERENCES choros.file (tenant_id, id),
  -- Monotonic version number is unique per file.
  UNIQUE (tenant_id, file_id, version_no),
  -- The S3 key is unique within the tenant (one object per version).
  UNIQUE (tenant_id, object_key)
);

-- Listing/ordering versions of a file.
CREATE INDEX IF NOT EXISTS file_version_by_file
  ON choros.file_version (tenant_id, file_id, version_no);

ALTER TABLE choros.file_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.file_version FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros' AND tablename = 'file_version'
      AND policyname = 'file_version_tenant_isolation'
  ) THEN
    CREATE POLICY file_version_tenant_isolation ON choros.file_version
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.file_version TO choros_app;

-- NOTE: file.current_version → file_version.id is an INTRA-tenant pointer. It is
-- intentionally NOT declared as a DB FK because file_version is INSERT-ed AFTER the
-- file row exists and points BACK to it — a hard FK would create a chicken-and-egg
-- ordering. The pointer is maintained by the application write-path (addVersion).
