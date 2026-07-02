-- 117 · default_read_grant_backfill (T-0570, D3: READ-PDP) — backfill the
-- tenant-wide default-open READ grant into EVERY EXISTING tenant.
--
-- WHY: T-0570 turns GET /api/records and GET /api/records/:id into READ-PDP
-- consumers (they now ask the SAME grant-resolver PDP that already gates
-- actions). Before that gate can go live, EVERY existing tenant must already
-- hold a covering READ grant — otherwise the day-1 flip would hide every
-- record from every actor who could see it yesterday (NF-2 backward-compat
-- floor: the backfill is a PRECONDITION of turning the gate on, not a
-- consequence). `src/core/register.ts` seeds this same grant for every NEW
-- tenant at registration time (registerTenant, T-0570 §2.2 block 3m-3p); this
-- migration is the one-time catch-up for tenants that registered BEFORE this
-- release.
--
-- ANTI-PATTERN THIS AVOIDS (explicit, FF-RP-6 / anti-case gate): migration 088
-- (configurator_authoring_draft_grant_seed) hardcodes ONE tenant UUID
-- ('a0000000-0000-0000-0000-000000000001') in every INSERT — it seeds only the
-- dev silo tenant, never a real self-registered tenant. That pattern is
-- EXPLICITLY FORBIDDEN here: this migration seeds via
-- `INSERT ... SELECT ... FROM choros.tenant t`, iterating every row of the
-- tenant table, so it backfills EVERY tenant that exists at apply-time — not a
-- fixed id, not a subset, no exceptions.
--
-- WHAT THIS MIGRATION ADDS (pure INSERT, zero DDL, zero new tables), PER
-- TENANT (one row set per `choros.tenant` row):
--   A. role row:              role-reader        (holds the READ grant below)
--   B. role_assignment row:   tenant-owner → role-reader (CONFIRMED)
--   C. role_assignment row:   assistant-agent → role-reader (CONFIRMED) — ONLY
--                              for tenants that already have an assistant-agent
--                              employee row (T-0373); a tenant seeded before
--                              T-0373 existed has no such employee and is
--                              skipped for this one assignment (LEFT JOIN +
--                              WHERE NOT NULL guards it — no FK violation).
--   D. grant row:              read/record, scope = RESOURCE_ROOT sentinel,
--                              CONFIRMED, delegable=true.
--
-- IDS: `gen_random_uuid()` per row (pgcrypto, already enabled — migrations
-- reference it elsewhere) — NOT a fixed/derived UUID, so re-running is a
-- pure no-op via each row's own idempotency key (see below), never a UUID
-- collision.
--
-- IDEMPOTENCY (safe to re-run):
--   - role:            ON CONFLICT ON CONSTRAINT (tenant_id, slug) unique
--                       (migration 019 `UNIQUE (tenant_id, slug)`) DO NOTHING.
--   - role_assignment: no natural unique key (by design, migration 020) — a
--                       `WHERE NOT EXISTS (...)` guard on
--                       (tenant_id, employee_id, role_id) makes the INSERT
--                       idempotent WITHOUT relying on a DB constraint, mirroring
--                       the same "no duplicate assignment" intent the code-path
--                       (register.ts) gets for free via ON CONFLICT DO NOTHING
--                       on a fixed PK (registerTenant generates a fresh id per
--                       call so the PK never collides — a re-appliable SQL
--                       migration instead must self-guard via WHERE NOT EXISTS
--                       since gen_random_uuid() differs on every re-run).
--   - grant:           same `WHERE NOT EXISTS` guard on
--                       (tenant_id, role_id, resource_type, operation, scope)
--                       — one default-open READ grant per tenant, ever.
--
-- SCOPE = {"kind":"node","hierarchy":"resource","nodeLevel":"application",
--          "nodeId":"00000000-0000-0000-0000-0000000000r0"} — the
-- RESOURCE_ROOT_NODE_ID sentinel (src/core/read-visibility.ts), identical for
-- every tenant. Differentiation across tenants is RLS + the grant row's own
-- `tenant_id` column (this INSERT's per-row tenant_id = t.id) — NEVER the
-- nodeId (NF-3). The composite resource-ancestry oracle
-- (src/db/resource-ancestry.ts) treats this exact nodeId as "covers every
-- resource node in this tenant's tree" in O(1) (ADR §2.1 rule 2).

-- ============================================================
-- A. role — role-reader, one per tenant.
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
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ============================================================
-- B. role_assignment — tenant-owner employee → role-reader, one per tenant.
--    "tenant-owner" role_assignment already exists per tenant (registerTenant
--    3d / dev seed); we resolve the OWNER as the employee holding a CONFIRMED
--    assignment to the 'tenant-owner' role (mirrors findTenantOwnerSlug in
--    grants-dao.ts, but by employee id here since this is a raw SQL backfill).
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   granted_by, confirmed_by, source, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  owner.employee_id,
  reader_role.id,
  '{"kind":"set","members":[]}'::jsonb,
  'migration-117',
  'migration-117',
  'registration',
  t.created_at,
  t.created_at
FROM choros.tenant t
JOIN choros.role reader_role
  ON reader_role.tenant_id = t.id AND reader_role.slug = 'role-reader'
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
     AND ra2.role_id = reader_role.id
);

-- ============================================================
-- C. role_assignment — assistant-agent employee → role-reader, one per
--    tenant THAT ALREADY HAS an assistant-agent employee row (T-0373). A
--    tenant seeded before T-0373 shipped has no such row — skipped here (no
--    FK violation possible: the JOIN simply yields no row for it).
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   granted_by, confirmed_by, source, created_at, updated_at)
SELECT
  t.id,
  gen_random_uuid(),
  agent.id,
  reader_role.id,
  '{"kind":"set","members":[]}'::jsonb,
  'migration-117',
  'migration-117',
  'registration',
  t.created_at,
  t.created_at
FROM choros.tenant t
JOIN choros.role reader_role
  ON reader_role.tenant_id = t.id AND reader_role.slug = 'role-reader'
JOIN choros.employee agent
  ON agent.tenant_id = t.id AND agent.slug = 'assistant-agent' AND agent.kind = 'agent'
WHERE NOT EXISTS (
  SELECT 1 FROM choros.role_assignment ra2
   WHERE ra2.tenant_id = t.id
     AND ra2.employee_id = agent.id
     AND ra2.role_id = reader_role.id
);

-- ============================================================
-- D. grant — read/record, scope = RESOURCE_ROOT sentinel, one per tenant.
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
  'migration-117',
  NULL,
  'migration-117',
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
