-- 036 · substitution_rule (T-0035 E4.7) — who substitutes for whom, over what
-- role and org_scope, across [valid_from, valid_until). Proposal/confirmation
-- contract mirrors role_assignment (020): confirmed_by NULL = proposal (zero
-- capability), NOT NULL = effective. Tenant-isolated (T-0013 invariants):
-- tenant_id leading PK, FORCE RLS, default-DENY policy, choros_app DML-only.
-- TTL'd grant (Tier-2) is recorded by ttl_grant_id → choros."grant"(tenant_id,
-- id); NULL for Tier-1 (routing-only, no grant minted).
-- ADDITIVE & IDEMPOTENT.

CREATE TABLE IF NOT EXISTS choros.substitution_rule (
  tenant_id               uuid    NOT NULL,
  id                      uuid    NOT NULL,
  absent_employee_id      uuid    NOT NULL,
  substitute_employee_id  uuid    NOT NULL,
  role_id                 uuid    NOT NULL,
  org_scope               jsonb   NOT NULL,
  ttl_grant_id            uuid    NULL,
  non_inheritable_excluded boolean NOT NULL DEFAULT TRUE,
  proposed_by             text    NULL,
  confirmed_by            text    NULL,
  valid_from              bigint  NULL,
  valid_until             bigint  NULL,
  source                  text    NOT NULL,
  created_by              text    NOT NULL,
  created_at              bigint  NOT NULL,
  updated_at              bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT substitution_rule_no_self_sub
    CHECK (absent_employee_id <> substitute_employee_id),
  CONSTRAINT substitution_rule_window_sane
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until),
  FOREIGN KEY (tenant_id, absent_employee_id)
    REFERENCES choros.employee(tenant_id, id),
  FOREIGN KEY (tenant_id, substitute_employee_id)
    REFERENCES choros.employee(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES choros.role(tenant_id, id),
  FOREIGN KEY (tenant_id, ttl_grant_id)
    REFERENCES choros."grant"(tenant_id, id)
);

ALTER TABLE choros.substitution_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.substitution_rule FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'substitution_rule'
      AND policyname = 'substitution_rule_tenant_isolation'
  ) THEN
    EXECUTE '
      CREATE POLICY substitution_rule_tenant_isolation ON choros.substitution_rule
        USING (tenant_id = current_setting(''choros.tenant_id'', true)::uuid)
        WITH CHECK (tenant_id = current_setting(''choros.tenant_id'', true)::uuid)
    ';
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.substitution_rule TO choros_app;

-- Dev silo seed (AC-15): a-recon substitutes e-mironov under budget-approver in
-- the fin department org node. Tier-1 (ttl_grant_id NULL). confirmed_by='seed'.
-- Idempotent via fixed UUID PK + ON CONFLICT DO NOTHING.
INSERT INTO choros.substitution_rule
  (tenant_id, id, absent_employee_id, substitute_employee_id, role_id, org_scope,
   ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
   valid_from, valid_until, source, created_by, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'g0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000004',  -- e-mironov (absent)
   'd0000000-0000-0000-0000-000000000002',  -- a-recon (substitute)
   'e0000000-0000-0000-0000-000000000002',  -- budget-approver
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, TRUE, NULL, 'seed', NULL, NULL, 'manual', 'seed', 0, 0)
ON CONFLICT DO NOTHING;
