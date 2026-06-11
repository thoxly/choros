-- T-0043 (E5.3): mcp_tool registry — tenant-isolated table + dev seed.
--
-- Design discipline (T-0013 invariants):
--  - PK (tenant_id, id); tenant_id leads the PK (passes tenant_id_leading.sql).
--  - UNIQUE (tenant_id, name) — one tool name per tenant.
--  - ENABLE + FORCE RLS + isolation policy.
--  - choros_app: DML only (no DDL).
--  - DB CHECK covers the structural floor of FR-5:
--      empty declares (=[]) → pure_compute MUST be true.
--    Full non-empty consistency is enforced by the TS write-path (validateMcpToolWrite).
--  - declares: jsonb NOT NULL DEFAULT '[]' — EffectDeclaration[].
--  - resource_ops: jsonb NOT NULL DEFAULT '[]' — ResourceOp[].
--  - Seed: ≥3 rows ON CONFLICT DO NOTHING (FF-13 / AC-6).
--
-- Migration number: 040 (T-0043; 032–039 reserved by in-flight parallel tasks).

CREATE TABLE choros.mcp_tool (
  tenant_id     uuid    NOT NULL,
  id            uuid    NOT NULL,
  name          text    NOT NULL,
  description   text        NULL,
  declares      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  pure_compute  boolean NOT NULL,
  resource_ops  jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at    bigint  NOT NULL,
  updated_at    bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT mcp_tool_name_uniq
    UNIQUE (tenant_id, name),

  -- Structural floor of FR-5: empty declares ⇒ pure_compute must be true.
  -- (non-empty declares consistency is TS-layer responsibility via classifyTool)
  CONSTRAINT mcp_tool_pure_empty_chk
    CHECK ((declares <> '[]'::jsonb) OR (pure_compute = true))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.mcp_tool ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.mcp_tool FORCE   ROW LEVEL SECURITY;

CREATE POLICY mcp_tool_tenant_isolation
  ON choros.mcp_tool
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.mcp_tool TO choros_app;

-- ---------------------------------------------------------------------------
-- Dev seed: 3 representative rows — one integration_endpoint tool,
-- one messaging_channel tool, one pure-compute (empty declares) tool.
-- All ON CONFLICT DO NOTHING for idempotency (FF-14 / AC-20).
-- Uses a stable dev-only tenant UUID that matches the genesis seed (migration 026).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  dev_tenant_id uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- Tool 1: integration_endpoint tool (declares one integration_endpoint effect)
  INSERT INTO choros.mcp_tool
    (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
  VALUES (
    dev_tenant_id,
    '10000000-0000-0000-0000-000000000001',
    'http-integration-tool',
    'Calls an external HTTP integration endpoint',
    '[{"resourceId": "20000000-0000-0000-0000-000000000001", "kind": "integration_endpoint"}]'::jsonb,
    false,
    '[{"resourceType": "effect_resource", "operation": "invoke"}]'::jsonb,
    0, 0
  )
  ON CONFLICT DO NOTHING;

  -- Tool 2: messaging_channel tool (declares one messaging_channel effect)
  INSERT INTO choros.mcp_tool
    (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
  VALUES (
    dev_tenant_id,
    '10000000-0000-0000-0000-000000000002',
    'slack-notify-tool',
    'Sends a notification via a messaging channel',
    '[{"resourceId": "20000000-0000-0000-0000-000000000002", "kind": "messaging_channel"}]'::jsonb,
    false,
    '[{"resourceType": "effect_resource", "operation": "invoke"}]'::jsonb,
    0, 0
  )
  ON CONFLICT DO NOTHING;

  -- Tool 3: pure-compute tool (empty declares, no side effects)
  INSERT INTO choros.mcp_tool
    (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
  VALUES (
    dev_tenant_id,
    '10000000-0000-0000-0000-000000000003',
    'json-transform-tool',
    'Transforms JSON data (pure compute, no side effects)',
    '[]'::jsonb,
    true,
    '[]'::jsonb,
    0, 0
  )
  ON CONFLICT DO NOTHING;
END;
$$;
