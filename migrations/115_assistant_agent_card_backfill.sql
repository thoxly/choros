-- 115 · Backfill agent_card row for existing assistant-agent employees (T-0574).
--
-- WHY: register.ts creates the per-tenant assistant-agent as an
-- employee(kind='agent', slug='assistant-agent') (step 3f) but historically wrote
-- NO agent_card row for it (see migrations/093 comment: "assistant-agent is
-- created per-tenant as an EMPLOYEE only ... and writes NO agent_card row today").
-- Consequence: GET /api/agents (registry-driven, FROM agent_card) never lists the
-- assistant, and PUT /api/agents/:id/llm-connection (setAgentLlmConnection UPDATEs
-- agent_card WHERE employee_id=$1) matches 0 rows → 404 AGENT_NOT_FOUND. The
-- owner can create an LLM-connection profile and insert a key on
-- /llm-connections, but has NO way to bind that profile to the assistant — the
-- BYO-LLM UI chain physically dead-ends (ADR-T0574 §1).
--
-- THIS MIGRATION (existing tenants): for every tenant whose assistant-agent
-- employee row exists but has NO matching agent_card row yet, insert one:
--   employee_id   = the assistant-agent's employee.id (addressing key, unchanged
--                    contract — mirrors the workforce-agent addressing scheme).
--   agent_type    = 'assistant' (taxonomy, migration 093).
--   kc_client_id  = 'assistant-agent-' || tenant_id — per-tenant deterministic,
--                    globally UNIQUE (migration 092 agent_card_kc_client_id_global_uq).
--                    NOT a Keycloak service account; NOT hardcoded (see below).
--   llm_endpoint / llm_model / llm_secret_handle / llm_connection_id = NULL
--                    (dormant; resolved later via llm_connection_id, T-0498).
--   autonomy_threshold = NULL.
--
-- register.ts gets the matching companion INSERT (3f-bis) for NEW tenants in the
-- same change — this migration covers only tenants that already exist.
--
-- NO HARDCODED TENANT: this migration contains NOT ONE literal tenant UUID. It is
-- fully SET-DRIVEN — INSERT ... SELECT ... FROM choros.employee e LEFT JOIN
-- choros.agent_card ac ... WHERE ac.id IS NULL — so it backfills every tenant in
-- the same statement, present and future-at-migration-time alike (checked by
-- ci/checks/demo/no-hardcoded-tenant.sh + ci/checks/seed/no-hardcoded-fixture-ids.sh).
--
-- IDEMPOTENT: the LEFT JOIN ... WHERE ac.id IS NULL predicate means a second run
-- selects zero rows (every assistant-agent employee already has its agent_card
-- row from the first run) — a pure no-op. ON CONFLICT DO NOTHING is additional
-- belt-and-braces against a concurrent racer inserting the same row between the
-- SELECT and the INSERT.
--
-- ADDITIVE: no ALTER, no new column, no new table — one INSERT...SELECT against
-- the existing choros.agent_card (migration 032/093 schema). tenant_id leads
-- (T-0013 invariant). Does not touch the llm_secret_handle seed-plane invariant
-- (FF-25-5): every backfilled row's llm_secret_handle is NULL, same as any other
-- freshly-provisioned dormant agent_card row.

INSERT INTO choros.agent_card
  (tenant_id, id, employee_id, employee_kind, agent_type, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, llm_connection_id,
   autonomy_threshold, created_at, updated_at)
SELECT
  e.tenant_id,
  gen_random_uuid(),
  e.id,
  'agent',
  'assistant',
  'assistant-agent-' || e.tenant_id::text,
  NULL, NULL, NULL, NULL,
  NULL,
  (extract(epoch from now()) * 1000)::bigint,
  (extract(epoch from now()) * 1000)::bigint
FROM choros.employee e
LEFT JOIN choros.agent_card ac
       ON ac.tenant_id = e.tenant_id AND ac.employee_id = e.id
WHERE e.slug = 'assistant-agent'
  AND e.kind = 'agent'
  AND ac.id IS NULL
ON CONFLICT DO NOTHING;
