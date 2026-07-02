-- 120 · ownerless_tenant_zero_unarm (T-0594, ADR-T0594 §2/§4 — finding R-2 of
-- the T-0573 review, docs/review/T-0573.review.json) — UNARMS the tenant-zero
-- assistant backfill (migration 118) for any tenant that has NO confirmed
-- role_assignment on role slug='tenant-owner' at apply-time (an "ownerless"
-- tenant).
--
-- WHY. migration 118 (already applied on stand + CI templates — its file is
-- NOT edited, an idempotent re-run will not happen) backfills the full
-- 9-row tenant-zero assistant invariant for every existing tenant missing
-- it. Its block A4 (owner -> role-configurator role_assignment) correctly
-- resolves the owner via a set-driven LATERAL join over confirmed
-- role_assignment rows on role-configurator's tenant-owner counterpart; for
-- a tenant with NO such confirmed row at all, that join yields the empty
-- set -- A4 inserts nothing (no fabricated owner, no crash). BUT blocks A5
-- (employee assistant-agent -> role-configurator role_assignment) and A6/A7
-- (4 grants on role-configurator: 2x authoring_draft + 2x capability) do NOT
-- depend on an owner existing at all -- their predicates only require
-- role-configurator (A1) and the assistant-agent employee (A2), BOTH of
-- which A1/A2 create unconditionally for every tenant. Net effect for an
-- ownerless tenant: role-configurator ends up armed with 4 confirmed grants
-- and an AGENT assignment, but NO HUMAN can ever inherit that role (zero
-- human role_assignment rows exist on it) -- a dangling, unreachable-by-a-
-- human grant set.
--
-- NOT a privilege escalation (the agent employee never authenticates as an
-- HTTP actor -- assistant chat runs under the OWNER's identity, ADR-T0573
-- §1; agentSlug is used only as a grant-intersection SUBJECT, never an auth
-- principal) and migration 118's own AC-1 invariant predicate already
-- honestly keeps flagging such a tenant as non-compliant (the owner ->
-- role-configurator branch of that OR-predicate never finds a row). Still,
-- leaving 4 confirmed grants + an agent assignment armed on a role no human
-- can ever hold is a rights-hygiene liability with zero corresponding
-- benefit today (ADR-T0594 §2 table) -- this migration removes exactly that
-- dangling armament, for exactly the tenants that still lack an owner at
-- the moment THIS migration runs.
--
-- WHERE OWNERLESS TENANTS COME FROM (not a live-code path): registerTenant
-- (src/core/register.ts, steps 3b-3d) inserts role(tenant-owner) + employee
-- + a CONFIRMED role_assignment for the owner as the FIRST steps of its DB
-- transaction, strictly BEFORE the tenant-zero block (3e-3j-bis). The
-- product cannot produce an ownerless tenant through any live path -- this
-- state is exclusively a test/acceptance-fixture orphan (a tenant seeded by
-- hand, bypassing registerTenant). See ADR-T0594 §1/§2 for the full
-- argument for why this migration DELETES the dangling armament rather than
-- waiting for an owner that the live product never fails to provide.
--
-- SCOPE (F3, structural -- not merely logical): this migration touches ONLY
-- choros.role_assignment and choros."grant". It contains NOT ONE DELETE
-- against choros.role / choros.employee / choros.agent_card -- the
-- role-configurator role, the assistant-agent employee row, and its
-- agent_card are left fully intact for every tenant (including ownerless
-- ones) as harmless, unarmed substrate: a future operator who manually
-- fixes an ownerless-tenant data orphan can re-arm the circuit (insert the
-- same role_assignment/grant rows migration 118's A5/A6/A7 would have
-- produced) WITHOUT having to recreate the role/employee/agent_card from
-- scratch.
--
-- MARKER-PRECISE (N4): both DELETE blocks are scoped to rows carrying
-- EXACTLY the marker migration 118 itself writes -- role_assignment.source
-- = 'backfill' AND role_assignment.confirmed_by = 'backfill' (B1), and
-- grant.confirmed_by = 'backfill' (B2). A grant or role_assignment on
-- role-configurator granted through some OTHER path (e.g. a human
-- administrator manually assigning role-configurator to someone after this
-- migration runs, or before it, through a different source/confirmed_by
-- marker) is NEVER touched by this migration -- deleting only what 118
-- itself is responsible for having armed.
--
-- R-1 (judge review of T-0594, docs/review/T-0594.review.json — applied
-- pre-promotion, while 120 was still UNAPPLIED anywhere so its body was
-- safe to edit): B1 requires confirmed_by = 'backfill' IN ADDITION to
-- source = 'backfill', not source alone. role_assignment.source is a
-- CLIENT-CONTROLLED free-text column (POST /api/role-assignments reads it
-- straight from the request body with only a typeof-string check, no
-- CHECK/enum — see ci/checks/db/role-assignment.test.ts 'arbitrary
-- non-empty source string accepted'), so a legitimate admin-created
-- assignment whose creator merely passed source='backfill' in the body
-- would be indistinguishable from a migration-118 row to a source-only
-- predicate (the judge constructed and verified this false positive live).
-- confirmed_by, by contrast, is ALWAYS server-derived from the
-- authenticated actor (R-AUTH, src/http/grants.ts) and can never be the
-- literal 'backfill' via the live write path — it is the trustworthy
-- discriminator, and B1 now matches B2's use of it (defense-in-depth
-- symmetry).
--
-- SET-DRIVEN, NO HARDCODED TENANT (N2): both blocks are driven by
-- `FROM choros.role_assignment ra ... JOIN choros.role cfg_role` / the
-- equivalent for grant -- no literal tenant UUID anywhere, same discipline
-- as migrations/118 (checked by ci/checks/db/migration-120-ownerless-unarm.
-- test.ts, mirroring ci/checks/migrations/no-hardcoded-tenant-uuid.sh's
-- regex for 118).
--
-- IDEMPOTENT (N3): a second run finds zero matching rows for any tenant
-- already unarmed by the first run (nothing left to delete) -- the
-- NOT EXISTS(confirmed tenant-owner assignment) guard does not depend on
-- this migration's own prior effect (it is evaluated purely against
-- role_assignment/role, which this migration never writes to), so it does
-- not oscillate.
--
-- NON-REGRESSION (N1): a tenant that DOES have a confirmed role_assignment
-- on role slug='tenant-owner' (full OR partial tenant-zero invariant) is
-- completely unaffected -- the NOT EXISTS guard in both blocks is false for
-- every one of its rows, so zero rows are deleted for it.

-- ============================================================
-- B1. role_assignment — remove the backfill-marked assistant-agent ->
--     role-configurator assignment, for every tenant that has NO confirmed
--     role_assignment on role slug='tenant-owner' at apply-time.
-- ============================================================

DELETE FROM choros.role_assignment ra
USING choros.role cfg_role,
      choros.employee agent
WHERE ra.tenant_id = cfg_role.tenant_id
  AND ra.role_id = cfg_role.id
  AND cfg_role.slug = 'role-configurator'
  AND ra.employee_id = agent.id
  AND agent.tenant_id = ra.tenant_id
  AND agent.slug = 'assistant-agent'
  AND agent.kind = 'agent'
  AND ra.source = 'backfill'
  AND ra.confirmed_by = 'backfill'
  AND NOT EXISTS (
    SELECT 1
      FROM choros.role_assignment owner_ra
      JOIN choros.role owner_role
        ON owner_role.tenant_id = owner_ra.tenant_id
       AND owner_role.id = owner_ra.role_id
     WHERE owner_ra.tenant_id = ra.tenant_id
       AND owner_role.slug = 'tenant-owner'
       AND owner_ra.confirmed_by IS NOT NULL
  );

-- ============================================================
-- B2. grant — remove the 4 backfill-marked grants (2x authoring_draft +
--     2x capability) on role-configurator, for every tenant that has NO
--     confirmed role_assignment on role slug='tenant-owner' at apply-time.
-- ============================================================

DELETE FROM choros."grant" g
USING choros.role cfg_role
WHERE g.tenant_id = cfg_role.tenant_id
  AND g.role_id = cfg_role.id
  AND cfg_role.slug = 'role-configurator'
  AND g.confirmed_by = 'backfill'
  AND NOT EXISTS (
    SELECT 1
      FROM choros.role_assignment owner_ra
      JOIN choros.role owner_role
        ON owner_role.tenant_id = owner_ra.tenant_id
       AND owner_role.id = owner_ra.role_id
     WHERE owner_ra.tenant_id = g.tenant_id
       AND owner_role.slug = 'tenant-owner'
       AND owner_ra.confirmed_by IS NOT NULL
  );
