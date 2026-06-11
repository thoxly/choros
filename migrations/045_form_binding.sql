-- 045 · form_binding (T-0072 E11.1) — named-binding contract table.
--
-- Tenant-table contract (identical to 043_invoke_proposal.sql / 022_effect_resource.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, tenant-isolation policy on
--   current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Design discipline (T-0017 FK lesson):
--   - PK (tenant_id, id) is self-contained; no cross-table FK declared.
--   - Natural key UNIQUE (tenant_id, process_key, form_key) — used by POST upsert
--     and GET lookup (FR-6 / ADR §2.1).
--   - fields jsonb NOT NULL — array of BindingField {key, type, required, label?}.
--   - version integer NOT NULL DEFAULT 1 — increments on every UPDATE.
--   - created_at / updated_at bigint (epoch ms).
--
-- Migration slot: 045 (044 = sibling T-0077 — non-intersecting slots).

CREATE TABLE choros.form_binding (
  tenant_id    uuid     NOT NULL,
  id           uuid     NOT NULL,
  process_key  text     NOT NULL,
  form_key     text     NOT NULL,
  fields       jsonb    NOT NULL,
  version      integer  NOT NULL DEFAULT 1,
  created_at   bigint   NOT NULL,
  updated_at   bigint   NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT form_binding_natural_key
    UNIQUE (tenant_id, process_key, form_key),

  CONSTRAINT form_binding_fields_is_array
    CHECK (jsonb_typeof(fields) = 'array')
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.form_binding ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.form_binding FORCE   ROW LEVEL SECURITY;

CREATE POLICY form_binding_tenant_isolation
  ON choros.form_binding
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.form_binding TO choros_app;

-- Dev-seed: one binding for the dev tenant, purchase-approval process.
-- fields mirror the 3 keys from web/src/forms/form-defs.js:
--   supplier, category, decision.
-- ON CONFLICT DO NOTHING makes the migration idempotent (NF-7 / AC-1).
INSERT INTO choros.form_binding
  (tenant_id, id, process_key, form_key, fields, version, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '0072feed-0000-0000-0000-000000000001',
  'purchase-approval',
  'purchase-form',
  '[
    {"key": "supplier",  "type": "string",  "required": true,  "label": "Supplier"},
    {"key": "category",  "type": "string",  "required": true,  "label": "Category"},
    {"key": "decision",  "type": "string",  "required": false, "label": "Decision"}
  ]'::jsonb,
  1,
  0,
  0
)
ON CONFLICT DO NOTHING;
