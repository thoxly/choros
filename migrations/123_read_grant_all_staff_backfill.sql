-- 123 · read_grant_all_staff_backfill (T-0619, ADR-T0619 §2.4) — extend the
-- covering READ grant (role-reader) to EVERY EXISTING human staff member of
-- EVERY tenant, not just the owner.
--
-- WHY. T-0570's READ-PDP gate is correct, but role-reader (the platform role
-- holding the tenant-wide default-open READ grant) was assigned ONLY to the
-- tenant owner (register.ts 3n / migration 117 block B) and assistant-agent
-- (register.ts 3o / migration 117 block C). A rank-and-file human employee —
-- one hired into the tenant, never the owner — held NO covering READ grant:
-- src/db/grants-dao.ts getGrantsForSubject returned zero read/record grants, so
-- src/http/records.ts served an empty LIST and 404'd every DETAIL. The employee
-- could not read even a record they had just created (LIVE_PROOF wave 2).
--
-- THIS MIGRATION (existing tenants only — NEW hires already get role-reader from
-- the hire flow, src/http/rights-intents.ts registerHire, and register.ts still
-- seeds the owner/assistant at registration time): for EVERY tenant, ensure the
-- role-reader role + its covering READ grant exist, then assign EVERY human
-- employee (employee.kind='human') that is not yet assigned to it. This closes
-- the catch-up gap for staff already hired BEFORE this release.
--
-- BOUNDARIES (security — do NOT widen, ADR-T0619 §2.2/§2.3):
--   - HUMANS ONLY. Block D assigns role-reader exclusively to employees with
--     kind='human'. Business agents get read via their OWN grants (a separate
--     agent-rights circuit); assistant-agent is already covered by migration
--     117 block C. This migration never assigns role-reader to a kind='agent'
--     employee.
--   - role-reader is a COVERING READ on the RESOURCE_ROOT sentinel with
--     resource_facet=NULL — record-level visibility only. It does NOT bypass
--     field-visibility: applyFieldVisibilityRedaction (records.ts) still redacts
--     hidden fields INDEPENDENTLY on top (composite gate). Not a super-grant.
--
-- NO HARDCODED TENANT (D-064 / anti-088): not one literal tenant UUID. Every
-- block is driven by `SELECT ... FROM choros.tenant` / `FROM choros.employee` —
-- set-driven over every tenant/employee at apply-time, exactly the migration
-- 117/118 pattern. The ONLY UUID-shaped literal present is the platform
-- RESOURCE_ROOT_NODE_ID sentinel ('00000000-0000-0000-0000-0000000000r0',
-- non-hex 'r' — structurally never a real tenant id), which is a tenant-agnostic
-- constant, identical for every tenant (differentiation is RLS + each row's own
-- tenant_id column, NEVER the nodeId).
--
-- NO CASE-SPECIFIC LITERAL (D-064): the staff set is selected generically by
-- `employee.kind = 'human'`, NEVER by enumerating persona slugs (e-larina,
-- e-orlov, ...). The grant is issued by a generic mechanism over "every human
-- employee of the tenant".
--
-- IDEMPOTENT (safe to re-run):
--   - role:            ON CONFLICT (tenant_id, slug) DO NOTHING (migration 019
--                       UNIQUE) — reuses the role migration 117 block A / a
--                       tenant's owner-seed already created.
--   - grant:           WHERE NOT EXISTS on (tenant_id, role_id, resource_type,
--                       operation, scope) — one default-open READ grant per
--                       tenant, ever (migration 117 block D may have created it).
--   - role_assignment: no natural unique key (migration 020) → WHERE NOT EXISTS
--                       on (tenant_id, employee_id, role_id) makes each INSERT
--                       idempotent WITHOUT a DB constraint (mirrors migration 117
--                       block B). A second run selects zero rows.
--
-- ADDITIVE (no ALTER, no new column, no new table): three INSERT ... SELECT
-- statements against EXISTING tables (role / grant / role_assignment). No
-- UPDATE, no DELETE — rows of already-assigned staff (owner, prior hires) are
-- left untouched; only the missing assignments are added.
--
-- SCOPE sentinel = {"kind":"node","hierarchy":"resource","nodeLevel":
-- "application","nodeId":"00000000-0000-0000-0000-0000000000r0"} — the same
-- RESOURCE_ROOT_NODE_ID sentinel register.ts / migration 117 use.

-- ============================================================
-- B'. role — role-reader, ensured for every tenant that lacks it (reuses the
--     role migration 117 block A / the owner-seed already created).
-- ============================================================

INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  'role-reader',
  'Читатель (по умолчанию)',
  t.created_at,
  t.created_at
FROM choros.tenant t
LEFT JOIN choros.role r
       ON r.tenant_id = t.id AND r.slug = 'role-reader'
WHERE r.id IS NULL
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ============================================================
-- C'. grant — read/record, scope = RESOURCE_ROOT sentinel, ensured on
--     role-reader for every tenant lacking it (WHERE NOT EXISTS — one
--     default-open READ grant per tenant, migration 117 block D may already
--     have created it).
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, proposed_by, confirmed_by,
   valid_from, valid_until, created_at)
SELECT
  t.id,
  gen_random_uuid(),
  reader_role.id,
  'record',
  NULL,
  'read',
  '{"kind":"node","hierarchy":"resource","nodeLevel":"application","nodeId":"00000000-0000-0000-0000-0000000000r0"}'::jsonb,
  NULL,
  true,
  'backfill',
  NULL,
  'backfill',
  NULL,
  NULL,
  t.created_at
FROM choros.tenant t
JOIN choros.role reader_role
  ON reader_role.tenant_id = t.id AND reader_role.slug = 'role-reader'
WHERE NOT EXISTS (
  SELECT 1 FROM choros."grant" g2
   WHERE g2.tenant_id = t.id
     AND g2.role_id = reader_role.id
     AND g2.resource_type = 'record'
     AND g2.operation = 'read'
     AND g2.scope = '{"kind":"node","hierarchy":"resource","nodeLevel":"application","nodeId":"00000000-0000-0000-0000-0000000000r0"}'::jsonb
);

-- ============================================================
-- D'. role_assignment — EVERY human employee (kind='human') → role-reader,
--     CONFIRMED, for every (tenant, human) pair not yet assigned. This is the
--     FULL-STAFF coverage T-0619 adds: the owner (already assigned by migration
--     117 block B) is skipped by WHERE NOT EXISTS; every other human staff
--     member gets the covering READ assignment. Agents (kind='agent') are
--     EXCLUDED (§2.2) — assistant-agent stays covered by migration 117 block C,
--     business agents read via their own grants.
--     No natural unique key on role_assignment (migration 020) → idempotency
--     via WHERE NOT EXISTS on (tenant_id, employee_id, role_id).
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   granted_by, confirmed_by, source, created_at, updated_at)
SELECT
  e.tenant_id,
  gen_random_uuid(),
  e.id,
  reader_role.id,
  '{"kind":"set","members":[]}'::jsonb,
  'backfill',
  'backfill',
  'backfill',
  e.created_at,
  e.created_at
FROM choros.employee e
JOIN choros.role reader_role
  ON reader_role.tenant_id = e.tenant_id AND reader_role.slug = 'role-reader'
WHERE e.kind = 'human'
  AND NOT EXISTS (
    SELECT 1 FROM choros.role_assignment ra2
     WHERE ra2.tenant_id = e.tenant_id
       AND ra2.employee_id = e.id
       AND ra2.role_id = reader_role.id
  );
