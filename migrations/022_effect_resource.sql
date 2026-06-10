-- T-0034 (E4.4): External-effect resource — first-class tenant table.
--
-- Design discipline (T-0017 FK lesson):
--  - PK (tenant_id, id) is self-contained; no cross-table FK is attempted.
--  - resource_type = 'effect_resource' in the grant table is a logical
--    descriptor (same discipline as grant.role_id and data_classification.resource_type).
--  - tenant_id leads the PK — passes tenant_id_leading.sql.
--  - kind is CHECK-constrained to the closed EffectKind set.
--  - ENABLE + FORCE RLS + isolation policy.
--
-- Migration number: 022 (T-0022 owns 019–021; T-0033 owns 017; T-0019 owns 018).
-- Must NOT reference tables from 019–021 (may not exist in bare schema sequences).

CREATE TABLE choros.effect_resource (
  tenant_id  uuid    NOT NULL,
  id         uuid    NOT NULL,
  kind       text    NOT NULL,
  scope      jsonb   NOT NULL,
  metadata   jsonb       NULL,
  created_at bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT effect_resource_kind_chk
    CHECK (kind IN ('integration_endpoint', 'messaging_channel', 'external_account'))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.effect_resource ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.effect_resource FORCE   ROW LEVEL SECURITY;

CREATE POLICY effect_resource_tenant_isolation
  ON choros.effect_resource
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.effect_resource TO choros_app;
