-- 017 · data_classification (T-0033 §3.3) — the per-tenant field-classification
-- table that raises the gateway facet from all-or-nothing field-presence to a
-- (class × grant) value-aware projection.
--
-- RUN SEAM (ADR): migration numbers 011/012 are taken by T-0116 and 013–016 by
-- T-0017 (org structure); T-0033 uses number `017`. known_tenant_tables.txt is
-- appended additively (the orchestrator does the merge-union).
--
-- Same tenant-table contract as 008_grant.sql / 004_registry_def.sql:
--   tenant_id leading PK, ENABLE+FORCE RLS, tenant-isolation policy on
--   current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- NO cross-table FK (T-0017 lesson — an impossible FK in DDL fails to apply =
-- BUILD bounce): `resource_type` is a KIND (not a row id) and `facet_field`
-- names a JSONB key inside registry_def.record_schema (a field name, not a row).
-- Neither (tenant_id, resource_type) nor facet_field maps to a single foreign
-- row, so no relational target exists — mirrors 008_grant.role_id's deferred-FK
-- discipline. The PK is self-contained (all four columns on this table).
--
-- `class` is the closed DataClass axis (S-1 egress_policy / S-3 role_criticality
-- join on it); a CHECK enumerates the closed set. NO egress column here — that
-- is T-0041's table, keyed on `class`.

CREATE TABLE choros.data_classification (
  tenant_id            uuid NOT NULL,
  resource_type        text NOT NULL,    -- T-0018 ResourceType (logical; NO FK)
  facet_field          text NOT NULL,    -- record-schema field name (logical; NO FK)
  facet_schema_version integer NOT NULL, -- the registry record-schema version classified
  class                text NOT NULL,    -- DataClass; CHECK enumerates the closed set
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL,
  PRIMARY KEY (tenant_id, resource_type, facet_field, facet_schema_version),
  CONSTRAINT data_classification_class_chk
    CHECK (class IN ('public', 'internal', 'confidential', 'restricted'))
);

ALTER TABLE choros.data_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.data_classification FORCE ROW LEVEL SECURITY;

CREATE POLICY data_classification_tenant_isolation ON choros.data_classification
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.data_classification TO choros_app;
