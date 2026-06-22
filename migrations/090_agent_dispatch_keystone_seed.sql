-- 090 · Agent-dispatcher keystone seed (T-0378 / E-PD-2) — ADDITIVE, DORMANT.
--
-- Seeds the minimum a DORMANT agent step needs so the PD-2 dispatcher keystone
-- runs end-to-end with ZERO LLM spend (job claimed → context assembled → motor
-- (dormant) → defer-to-human → engine step closes). The LIVE proceed path is a
-- later flip of agent_card.llm_* (RL-3 secret handle) — NO code change, NO new
-- migration. Honest-gate discipline (s37/s38): prove the weld dormant first.
--
-- What this adds (all ON CONFLICT DO NOTHING; idempotent; nothing removed/altered):
--   1. role  role-intake-agent — the role the BPMN tel-linear «Триаж» step names
--      (config/flowable/processes/tel-linear.bpmn20.xml comment: a-intake,
--      role-intake-agent). Day-1 it carries NO grants → role-criticality.ts derives
--      level='routine' (gate B does NOT force defer) and resolveAgentToolset → 0
--      tools (pure reasoning, no tool calls) — exactly the keystone shape.
--   2. role_assignment  a-triage (d…0006) → role-intake-agent — CONFIRMED & in-window
--      (confirmed_by set, valid_from/until NULL) so getGrantsForSubject /
--      getRoleSlugsForActor resolve the agent's role.
--   3. agent_instruction (tier='published') for a-triage — so the dispatcher's
--      readPublished returns a row (hasInstruction=true). With a dormant agent_card
--      (llm_* NULL, seeded by 032 — UNTOUCHED here) the motor still defers via the
--      dormant LLM port; the published instruction proves the gated-read seam works.
--
-- agent_card for d…0006 is ALREADY seeded DORMANT by 032 (llm_* NULL,
-- autonomy_threshold NULL) — this migration deliberately does NOT touch it (keeps
-- the agent dormant; the live flip is a separate, sanctioned config change).
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001 (matches 016/032/077).
-- a-triage employee = d0000000-0000-0000-0000-000000000006 (kind='agent', 016).
-- role-intake-agent  = e0000000-0000-0000-0000-000000000005 (prefix e0000000;
--   role-initiator=…0003, role-approver=…0004 are taken by 077; …0005 is free).

-- 1. role-intake-agent (the BPMN-named agent-step role; no grants day-1).
INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000005',
  'role-intake-agent',
  'Агент приёмки (триаж)',
  'PD-2 agent-step role — a-intake/триаж dispatcher executor. No grants day-1 (routine criticality, empty toolset); the dormant keystone agent does pure reasoning.',
  0, 0
)
ON CONFLICT DO NOTHING;

-- 2. CONFIRMED, in-window assignment: a-triage agent → role-intake-agent.
--    confirmed_by set ⇒ getGrantsForSubject / getRoleSlugsForActor pick it up.
--    org_scope '{}' = tenant-root scope (same shape as other dev assignments).
INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000090',     -- assignment id (prefix f0…, suffix=mig no.)
  'd0000000-0000-0000-0000-000000000006',     -- a-triage (kind='agent')
  'e0000000-0000-0000-0000-000000000005',     -- role-intake-agent
  '{}'::jsonb,
  NULL, NULL,
  'seed', 'system', 'system', 'system',
  0, 0
)
ON CONFLICT DO NOTHING;

-- 3. Published agent_instruction for a-triage so readPublished returns a row.
--    answer_form 'agent_step_v1' matches the dispatcher's neutral default.
--    The agent stays DORMANT (agent_card.llm_* NULL) — the published instruction
--    proves the gated read; the motor defers via the dormant port (zero spend).
INSERT INTO choros.agent_instruction
  (tenant_id, id, employee_id, employee_kind, tier,
   instruction_text, answer_form, instruction_meta, bundle_id,
   created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000090',     -- instruction artifact id
  'd0000000-0000-0000-0000-000000000006',     -- a-triage (kind='agent')
  'agent',
  'published',
  'Триаж входящей заявки: оценить заявку по приложенным полям и предложить решение (одобрить/на согласование). При сомнении — передать человеку.',
  'agent_step_v1',
  '{}'::jsonb,
  NULL,
  0, 0
)
ON CONFLICT DO NOTHING;
