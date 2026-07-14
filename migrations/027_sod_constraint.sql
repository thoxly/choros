-- 027 · sod_constraint (T-0032 E4.2) — SoD constraint DECLARATIONS.
--
-- The DECLARATION rows the SoD evaluation layer (src/core/sod.ts) folds over.
-- SoD itself is queries-only: static SoD is a query over effective
-- role_assignment rows, dynamic SoD is recomputed from actor_event at
-- action-time — neither introduces derived state. This table holds ONLY the
-- declarations (the incompatible role pairs / the per-object separation rules),
-- never a decision cache (ADR §2, rejected-alternatives).
--
-- Tenant table (T-0013 inherited verbatim): tenant_id NOT NULL leading PK
-- column; ENABLE + FORCE RLS; one default-DENY isolation policy on the
-- choros.tenant_id GUC; choros_app NOBYPASSRLS with a DML grant. role_a/role_b
-- carry NO FK to `role` (role FK is undesigned — mirrors grant.role_id in
-- 008_grant.sql and actor_event.role_at_event in 018; the no-cross-table-FK
-- discipline of T-0017). PK (tenant_id, id); self-contained.
--
--   - kind ∈ {static, dynamic} is a CLOSED CHECK set (ADR §4.2 / AC-1).
--   - a static constraint MUST name both roles (the incompatible pair); a
--     dynamic one MAY omit them — enforced by sod_constraint_static_shape.
--   - scope is a grant-lattice ScopeElement-shaped jsonb (org or resource
--     hierarchy) whose containment of the object is tested by the application
--     via the AncestryOracle; deeper scope-shape validation is an application
--     invariant (mirrors role_assignment.org_scope).

CREATE TABLE choros.sod_constraint (
  tenant_id    uuid    NOT NULL,
  id           uuid    NOT NULL,
  kind         text    NOT NULL CHECK (kind IN ('static', 'dynamic')),
  role_a       uuid    NULL,
  role_b       uuid    NULL,
  self_record  boolean NOT NULL DEFAULT false,
  scope        jsonb   NOT NULL,
  detail       jsonb   NULL,
  created_at   bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- static constraints MUST name both roles (the incompatible pair); dynamic MAY omit.
  CONSTRAINT sod_constraint_static_shape
    CHECK (kind <> 'static' OR (role_a IS NOT NULL AND role_b IS NOT NULL))
);

ALTER TABLE choros.sod_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.sod_constraint FORCE ROW LEVEL SECURITY;

CREATE POLICY sod_constraint_tenant_isolation ON choros.sod_constraint
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.sod_constraint TO choros_app;
