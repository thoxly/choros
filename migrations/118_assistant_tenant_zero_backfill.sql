-- 118 · assistant_tenant_zero_backfill (T-0573, ADR-T0573 §2.1) — backfill the
-- FULL tenant-zero assistant invariant (9 rows: role-configurator + employee
-- assistant-agent + agent_card + 2 role_assignment + 4 grant) into EVERY
-- EXISTING tenant that is missing any of it.
--
-- WHY. register.ts seeds this exact 9-row invariant to every NEW self-registered
-- tenant (steps 3e-3j-bis, T-0373/T-0475/T-0574). Tenants registered BEFORE that
-- code shipped have NONE of it: no role-configurator, no assistant-agent
-- employee, no agent_card, no role_assignment, no grant. LIVE_PROOF T-0574
-- (2026-07-02) found the gap is deeper than "agent_card missing" (which 115
-- alone backfills, and ONLY for tenants that already have the assistant-agent
-- employee row) — some existing tenants have NO assistant-agent employee at
-- all. Consequence observed live: the tenant owner opens the assistant-
-- configurator and gets AUTHORING_ACCESS_DENIED_MESSAGE (hasAuthoringDraftGrant
-- sees an empty intersection — no employee → no role_assignment → no grant),
-- and GET /api/agents cannot address the assistant (no agent_card row) so
-- "Назначить ассистенту" on /llm-connections has nothing to bind to.
--
-- THIS MIGRATION (existing tenants only — NEW tenants already get all 9 rows
-- from register.ts at registration time): for EVERY tenant missing any of the
-- 9 rows, insert exactly the missing ones. Each block is its own
-- INSERT ... SELECT ... LEFT JOIN ... WHERE <partner-row> IS NULL (or, for
-- role_assignment, a WHERE NOT EXISTS guard — mirrors migration 117's pattern,
-- since role_assignment carries no natural unique key) + ON CONFLICT DO NOTHING.
-- Order matters: A1 (role) before A3/A4 (which need the role); A2 (employee)
-- before A3/A5 (which need the employee); A4/A5 read the role/employee rows
-- that may have been created earlier in this SAME statement batch (each block
-- re-SELECTs from the base tables, so a row inserted by an earlier block in
-- this same migration run is visible to a later block).
--
-- NO HARDCODED TENANT (N2/AC-3): this migration contains NOT ONE literal
-- tenant UUID. Every block is driven by `SELECT ... FROM choros.tenant t` (or
-- a table joined back to it) — set-driven over every tenant that exists at
-- apply-time, exactly the migration-115/117 pattern. Checked by
-- ci/checks/migrations/no-hardcoded-tenant-uuid.sh (new, FF-4) plus the
-- existing ci/checks/demo/no-hardcoded-tenant.sh and
-- ci/checks/seed/no-hardcoded-fixture-ids.sh (both scan other paths, kept
-- green as compatibility, per ADR-T0573 §1 correction).
--
-- IDEMPOTENT (N1/AC-2): every block's predicate ("partner row IS NULL" / "count
-- < N" / "WHERE NOT EXISTS") means a second run selects zero rows for any
-- tenant already fully backfilled — a pure no-op. ON CONFLICT DO NOTHING is
-- additional belt-and-braces against a concurrent racer.
--
-- ADDITIVE (N3): no ALTER, no new column, no new table — seven INSERT...SELECT
-- statements against EXISTING tables (role/employee/agent_card/role_assignment/
-- grant, all pre-existing schema). No UPDATE, no DELETE — existing rows of
-- tenants that already have part of the invariant are left untouched; only the
-- missing remainder is added.
--
-- OWNER RESOLUTION (F2): the target of the new owner→role-configurator
-- role_assignment (A4) is the employee holding a CONFIRMED role_assignment on
-- the role slug='tenant-owner' for that tenant (mirrors register.ts 3d/3g: the
-- same employee that self-bootstraps the tenant-owner assignment at
-- registration is the one register.ts grants role-configurator to). No
-- literal UUID — resolved entirely via SELECT/JOIN against role/role_assignment.
--
-- ANTI-DRIFT (register.ts vs this migration, ADR-T0573 §2.1): NOT closed by
-- shared code (a SQL<->TS refactor of the registration transaction would be
-- disproportionate) but by a fitness cross-check (FF-2, see
-- migration-118-tenant-zero-backfill.test.ts) — a freshly registerTenant()'d
-- tenant AND a backfilled pre-existing tenant both satisfy the SAME AC-1
-- invariant SQL predicate. If register.ts and this migration ever diverge,
-- FF-2 goes red.
--
-- Does NOT write llm_secret_handle (omitted/NULL — dormant; FF-25-5 seed-plane
-- invariant untouched, same as register.ts 3f-bis and migration 115). No
-- case-specific literal (tenant name / e-mail from the live acceptance run) —
-- N4/AC-3.

-- ============================================================
-- A1. role — role-configurator, for every tenant that lacks it.
-- ============================================================

INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  'role-configurator',
  'Конфигуратор системы',
  t.created_at,
  t.created_at
FROM choros.tenant t
LEFT JOIN choros.role r
       ON r.tenant_id = t.id AND r.slug = 'role-configurator'
WHERE r.id IS NULL
ON CONFLICT DO NOTHING;

-- ============================================================
-- A2. employee — assistant-agent (kind='agent'), for every tenant that
--     lacks it.
-- ============================================================

INSERT INTO choros.employee
  (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  'assistant-agent',
  'agent',
  'Ассистент (AI-агент)',
  NULL,
  t.created_at,
  t.created_at
FROM choros.tenant t
LEFT JOIN choros.employee e
       ON e.tenant_id = t.id AND e.slug = 'assistant-agent' AND e.kind = 'agent'
WHERE e.id IS NULL
ON CONFLICT DO NOTHING;

-- ============================================================
-- A3. agent_card — for the assistant-agent employee of every tenant that
--     lacks it (exact shape of migration 115; runs AFTER A2 in this same
--     migration so it also covers employees created by A2 above).
-- ============================================================

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

-- ============================================================
-- A4. role_assignment — tenant owner → role-configurator (F2), for every
--     tenant missing this CONFIRMED assignment. Owner = the employee holding
--     a CONFIRMED role_assignment on role slug='tenant-owner' for this
--     tenant (register.ts 3d/3g's same self-bootstrap owner).
--     No natural unique key on role_assignment (migration 020) → idempotency
--     via WHERE NOT EXISTS, mirroring migration 117 block B.
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   granted_by, confirmed_by, source, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  owner.employee_id,
  cfg_role.id,
  '{"kind":"set","members":[]}'::jsonb,
  'backfill',
  'backfill',
  'backfill',
  t.created_at,
  t.created_at
FROM choros.tenant t
JOIN choros.role cfg_role
  ON cfg_role.tenant_id = t.id AND cfg_role.slug = 'role-configurator'
JOIN LATERAL (
  SELECT ra.employee_id
    FROM choros.role_assignment ra
    JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = t.id
     AND r.slug = 'tenant-owner'
     AND ra.confirmed_by IS NOT NULL
   ORDER BY ra.created_at ASC
   LIMIT 1
) owner ON true
WHERE NOT EXISTS (
  SELECT 1 FROM choros.role_assignment ra2
   WHERE ra2.tenant_id = t.id
     AND ra2.employee_id = owner.employee_id
     AND ra2.role_id = cfg_role.id
     AND ra2.confirmed_by IS NOT NULL
);

-- ============================================================
-- A5. role_assignment — assistant-agent employee → role-configurator, for
--     every tenant missing this CONFIRMED assignment. granted_by/confirmed_by
--     = the same tenant owner resolved in A4 (register.ts 3h uses the genesis
--     owner as confirmed_by for this assignment too).
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   granted_by, confirmed_by, source, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  agent.id,
  cfg_role.id,
  '{"kind":"set","members":[]}'::jsonb,
  'backfill',
  'backfill',
  'backfill',
  t.created_at,
  t.created_at
FROM choros.tenant t
JOIN choros.role cfg_role
  ON cfg_role.tenant_id = t.id AND cfg_role.slug = 'role-configurator'
JOIN choros.employee agent
  ON agent.tenant_id = t.id AND agent.slug = 'assistant-agent' AND agent.kind = 'agent'
WHERE NOT EXISTS (
  SELECT 1 FROM choros.role_assignment ra2
   WHERE ra2.tenant_id = t.id
     AND ra2.employee_id = agent.id
     AND ra2.role_id = cfg_role.id
     AND ra2.confirmed_by IS NOT NULL
);

-- ============================================================
-- A6. grant — authoring_draft / create + authoring_draft / update on
--     role-configurator (register.ts 3i/3j), for every tenant with fewer
--     than 2 such CONFIRMED grants.
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, proposed_by, confirmed_by,
   valid_from, valid_until, created_at)
SELECT
  t.id,
  gen_random_uuid(),
  cfg_role.id,
  vals.resource_type,
  NULL,
  vals.operation,
  '{"kind":"set","members":[]}'::jsonb,
  NULL,
  false,
  'backfill',
  NULL,
  'backfill',
  NULL,
  NULL,
  t.created_at
FROM choros.tenant t
JOIN choros.role cfg_role
  ON cfg_role.tenant_id = t.id AND cfg_role.slug = 'role-configurator'
CROSS JOIN (
  VALUES ('authoring_draft', 'create'), ('authoring_draft', 'update')
) AS vals(resource_type, operation)
WHERE (
  SELECT COUNT(*) FROM choros."grant" g
   WHERE g.tenant_id = t.id AND g.role_id = cfg_role.id
     AND g.resource_type = 'authoring_draft' AND g.operation IN ('create', 'update')
     AND g.confirmed_by IS NOT NULL
) < 2
  AND NOT EXISTS (
    SELECT 1 FROM choros."grant" g2
     WHERE g2.tenant_id = t.id AND g2.role_id = cfg_role.id
       AND g2.resource_type = vals.resource_type AND g2.operation = vals.operation
       AND g2.confirmed_by IS NOT NULL
  );

-- ============================================================
-- A7. grant — llm_connection:configure/configure + system_agent:operate/
--     operate (capability grants, register.ts 3j-bis / T-0475) on
--     role-configurator, for every tenant with fewer than 2 such CONFIRMED
--     grants.
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, proposed_by, confirmed_by,
   valid_from, valid_until, created_at)
SELECT
  t.id,
  gen_random_uuid(),
  cfg_role.id,
  vals.resource_type,
  NULL,
  vals.operation,
  '{"kind":"set","members":[]}'::jsonb,
  NULL,
  false,
  'backfill',
  NULL,
  'backfill',
  NULL,
  NULL,
  t.created_at
FROM choros.tenant t
JOIN choros.role cfg_role
  ON cfg_role.tenant_id = t.id AND cfg_role.slug = 'role-configurator'
CROSS JOIN (
  VALUES ('llm_connection:configure', 'configure'), ('system_agent:operate', 'operate')
) AS vals(resource_type, operation)
WHERE (
  SELECT COUNT(*) FROM choros."grant" g
   WHERE g.tenant_id = t.id AND g.role_id = cfg_role.id
     AND g.resource_type IN ('llm_connection:configure', 'system_agent:operate')
     AND g.confirmed_by IS NOT NULL
) < 2
  AND NOT EXISTS (
    SELECT 1 FROM choros."grant" g2
     WHERE g2.tenant_id = t.id AND g2.role_id = cfg_role.id
       AND g2.resource_type = vals.resource_type AND g2.operation = vals.operation
       AND g2.confirmed_by IS NOT NULL
  );
