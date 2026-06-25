-- 106 · app:// encrypted secret store (T-0476, E-AGENTS L3)
--
-- Spec: docs/specs/agent-registry-and-llm-keys.spec.md §4 point 4, §5, §8 L3.
--
-- THE L3 ENCRYPTED-KEY STORE. T-0474 (migration 094) gave the tenant a place to
-- name an LLM connection profile and carry an OPAQUE secret_handle, but a self-
-- registered tenant still had no way to bring its OWN API key from the UI — the
-- only resolvable handle was the operator-only env:// fallback. This migration adds
-- the at-rest encrypted store behind the new app://<id> handle scheme:
--
--   UI "вставить API-ключ" (write-only) → POST encrypts the raw key with AES-256-GCM
--   (random per-row nonce, master key from env APP_SECRET_MASTER_KEY) → only the
--   CIPHERTEXT + NONCE + key_version land here → llm_connection.secret_handle is set
--   to app://<this row id>. The raw key is NEVER stored, NEVER returned, NEVER logged.
--   resolveSecret('app://<id>') decrypts IN MEMORY ONLY at call time.
--
-- key_version is carried for future master-key ROTATION (non-goal §10 — only the
-- column is laid down now; the rotation procedure is a later task).
--
-- ADDITIVE / IDEMPOTENT / APPEND-ONLY:
--   * Next free slot after 105 (dev has 093/094/103/104/105; 106 is unused).
--   * Same tenant-table contract as 094_llm_connection / 016_employee / 032_agent_card:
--     tenant_id leading PK column, ENABLE+FORCE RLS, tenant-isolation policy on
--     current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--     listed in ci/checks/known_tenant_tables.txt (defer-no-new-table relief
--     appended in ci/checks/defer-no-new-table.sh via the T-0474 auto-additive path).
--   * Every step guarded (CREATE TABLE IF NOT EXISTS, conditional policy creation)
--     so a re-run is a no-op.
--   * APPEND-BY-VERSION: rows are never updated in place — rotating a key INSERTs a
--     new app_secret row and re-points llm_connection.secret_handle; the old row may
--     be deleted by its owner. No UPDATE of ciphertext (the cipher columns are write-
--     once per row).

-- ── The app_secret table (NEW, tenant-isolated, FORCE RLS). ────────────────────
-- One row = one encrypted secret. ciphertext+nonce are the AES-256-GCM output
-- (the GCM auth tag is appended to ciphertext by the cipher module — see
-- src/core/app-secret-cipher.ts). key_version identifies which master key sealed
-- the row (1 = the current APP_SECRET_MASTER_KEY). The RAW key is NOT a column.
CREATE TABLE IF NOT EXISTS choros.app_secret (
  tenant_id   uuid    NOT NULL,
  id          uuid    NOT NULL DEFAULT gen_random_uuid(),
  ciphertext  bytea   NOT NULL,                 -- AES-256-GCM ciphertext WITH appended 16-byte auth tag
  nonce       bytea   NOT NULL,                 -- random 12-byte GCM IV, unique per row
  key_version int     NOT NULL DEFAULT 1,       -- which master key sealed this row (rotation hook)
  created_by  text    NULL,                     -- actor slug/sub that stored the secret (audit hint)
  created_at  bigint  NOT NULL,
  updated_at  bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT app_secret_ciphertext_nonempty_chk CHECK (octet_length(ciphertext) > 0),
  CONSTRAINT app_secret_nonce_len_chk           CHECK (octet_length(nonce) = 12),
  CONSTRAINT app_secret_key_version_chk         CHECK (key_version >= 1)
);

ALTER TABLE choros.app_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.app_secret FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'app_secret'
      AND policyname = 'app_secret_tenant_isolation'
  ) THEN
    CREATE POLICY app_secret_tenant_isolation ON choros.app_secret
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.app_secret TO choros_app;

COMMENT ON TABLE choros.app_secret IS
  'L3 (T-0476) at-rest encrypted secret store for the app://<id> handle scheme. '
  'Holds AES-256-GCM ciphertext+nonce only — NEVER a raw key. Decrypted in memory '
  'by resolveSecret(app://<id>); the plaintext never egresses, is logged, or returned.';
