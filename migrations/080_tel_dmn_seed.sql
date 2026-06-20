-- 080 · tel_dmn_seed (T-0340 E15-S5)
--
-- DATA-ONLY migration: seed the 5,000,000 ₽ approval-threshold DMN rule table
-- into choros.dmn_rule_table (migration 066) for the canonical ТЭЛ process.
--
-- NO CREATE TABLE. NO schema changes. Pure data INSERT, idempotent ON CONFLICT.
-- Passes defer-no-new-table.sh (D-061 / FF-DC7, T-0221).
--
-- Design (machinery-plan §3 S5 / F4):
--   The ТЭЛ (procurement approval) process has an exclusiveGateway that routes
--   based on purchase amount:
--     amount > 5,000,000 → "needs-approval"  (extra approver required)
--     amount <= 5,000,000 → "standard"        (standard track)
--
--   The rule table uses hitPolicy=FIRST (first matching row wins).
--   The routing outcome name is "approvalRequired" (matches TEL_GATEWAY_VAR
--   constant in src/core/dmn-gateway.ts and the BPMN conditionExpression).
--
-- Tenancy:
--   Rule tables are tenant-scoped (RLS). This seed inserts a GLOBAL-scope
--   entry (process_def_id = NULL) under the canonical dev/seed tenant
--   (see seed/demo/tel-scenario.ts for the SEED_TENANT_ID used throughout).
--   The migration is idempotent: ON CONFLICT (tenant_id, id) DO NOTHING.
--
-- In-flight rule-change semantics (§8 founder decision):
--   New process launches load the 'published' row at launch time and pin the
--   updated_at version in process variables (dmn_rtv_* keys). Running instances
--   re-evaluate on the OLD (pinned) snapshot. This migration only INSERTs a new
--   row; existing pinned references are unaffected.
--
-- Known tenant: 'aaaaaaaa-0000-0000-0000-000000000001' is the canonical seed
-- tenant used in ci/checks/db/* tests and seed/demo/tel-scenario.ts.
-- The id is a deterministic UUID for this seed row so the migration is
-- repeatable and testable without a random UUIDv4 that changes per run.

BEGIN;

INSERT INTO choros.dmn_rule_table (
  tenant_id,
  id,
  name,
  definition,
  process_def_id,
  status,
  created_at,
  updated_at
)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'c0de0001-e150-0005-d4f4-000000000080'::uuid,
  'ТЭЛ: порог суммы закупки',
  '{
    "id": "c0de0001-e150-0005-d4f4-000000000080",
    "name": "ТЭЛ: порог суммы закупки",
    "hitPolicy": "FIRST",
    "rules": [
      {
        "annotation": "Сумма > 5 000 000 ₽ — требуется доп. согласование",
        "conditions": [
          { "field": "amount", "operator": "gt", "value": 5000000 }
        ],
        "effects": [
          { "kind": "set_routing_outcome", "name": "approvalRequired", "value": "needs-approval" }
        ]
      },
      {
        "annotation": "Стандартный трек (сумма в пределах порога)",
        "conditions": [],
        "effects": [
          { "kind": "set_routing_outcome", "name": "approvalRequired", "value": "standard" }
        ]
      }
    ]
  }'::jsonb,
  NULL,
  'published',
  NOW(),
  NOW()
)
ON CONFLICT (tenant_id, id) DO NOTHING;

COMMIT;
