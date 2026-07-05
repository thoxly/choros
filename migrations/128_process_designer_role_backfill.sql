-- 128 · process_designer_role_backfill (T-0666, ADR-T0666 §2.2) — seed the
-- `process_designer` role for EVERY EXISTING tenant that is missing it.
--
-- WHY. checkRole (src/http/binding.ts) — the single conventional (non-PDP-
-- grant) authz gate shared by POST /api/forms/binding, the Floor-1 editor
-- (floor1-editor.ts), and the DMN rule-table save path (dmn-rule-table.ts) —
-- looks up `role.slug = 'process_designer'` in keycloak auth mode. Before
-- this task the role existed in NO tenant (not the dev-silo migrations, not
-- registerTenant) — the lookup always found zero rows, so keycloak-mode form
-- save was 403 FORBIDDEN for every actor, INCLUDING the tenant owner
-- (LIVE_PROOF T-0656 had to grant the role by hand in the DB to proceed).
--
-- T-0666 fixes register.ts to seed this role for NEW tenants going forward
-- (register.ts §3q). This migration closes the same gap for tenants that
-- already existed before that change shipped — mirrors migration 118's
-- set-driven, no-hardcoded-tenant, idempotent backfill pattern.
--
-- THE ROLE IS SEEDED BUT NOT AUTO-ASSIGNED (same posture as
-- role-constructor-admin, register.ts §3k / migration precedent): the owner
-- already gets form-save access through the checkRole owner short-circuit
-- (isGenesisOwnerForTenant, ADR-T0666 §2.1) — this migration only makes the
-- role exist as an assignable principal so the owner CAN delegate it to a
-- staff form-builder through the existing rights-assignment machinery.
--
-- NO HARDCODED TENANT (mirrors migration 118/124): driven entirely by
-- `SELECT ... FROM choros.tenant t LEFT JOIN choros.role r ON ... WHERE
-- r.id IS NULL` — every tenant that exists at apply-time, whether it is the
-- dev silo or a self-registered production tenant.
--
-- IDEMPOTENT: the LEFT JOIN ... WHERE r.id IS NULL predicate means a second
-- run selects zero rows for any tenant that already has the role (including
-- tenants registered after register.ts §3q shipped). ON CONFLICT DO NOTHING
-- is additional belt-and-braces against a concurrent racer.
--
-- ADDITIVE: no ALTER, no new column, no new table — one INSERT ... SELECT
-- against the existing choros.role table (migration 019 schema, unchanged).
-- No UPDATE, no DELETE, no role_assignment/grant row is touched — the role
-- is created, nothing is assigned to it here.
--
-- ANTI-CASE: 'process_designer' is a platform primitive slug (the literal
-- checkRole already matches in binding.ts, T-0072) — not case-specific
-- content. Display name/description are generic platform copy, no case
-- literal (mirrors migration 118's role-configurator seed text).

INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  'process_designer',
  'Конструктор форм',
  'Platform role gating form-binding / floor1-editor / dmn-rule-table save access (checkRole, T-0072/T-0666) — seeded, not auto-assigned; the owner has access via the checkRole owner bypass regardless.',
  t.created_at,
  t.created_at
FROM choros.tenant t
LEFT JOIN choros.role r
       ON r.tenant_id = t.id AND r.slug = 'process_designer'
WHERE r.id IS NULL
ON CONFLICT DO NOTHING;
