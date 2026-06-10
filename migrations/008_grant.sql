-- 008 · grant (T-0018 §4.1) — the grant authority table.
--
-- `grant` and `constraint` are SQL reserved words → the table name and that
-- column are double-quoted throughout. relname recorded in known_tenant_tables
-- is `grant`.
--
-- role_id is a PLAIN uuid NOT NULL column carrying NO cross-table FK: the FK to
-- role(tenant_id, id) is DEFERRED to T-0022's migration (ADR §1.2), because
-- role/assignment are undesigned — a baseline FK to a non-existent table would
-- fail to apply (AC-14). The NOT NULL floor (the ratified T-0018 contract the
-- resolver T-0021 reads) still holds today.
--
-- scope jsonb NOT NULL (AC-15); resource_facet / constraint jsonb NULL.

CREATE TABLE choros."grant" (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  role_id        uuid NOT NULL,
  resource_type  text NOT NULL,
  resource_facet jsonb NULL,
  operation      text NOT NULL,
  scope          jsonb NOT NULL,
  "constraint"   jsonb NULL,
  delegable      boolean NOT NULL DEFAULT true,
  granted_by     text NOT NULL,
  valid_from     bigint NULL,
  valid_until    bigint NULL,
  created_at     bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros."grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros."grant" FORCE ROW LEVEL SECURITY;

CREATE POLICY grant_tenant_isolation ON choros."grant"
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros."grant" TO choros_app;
