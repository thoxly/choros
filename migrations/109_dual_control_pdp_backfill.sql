-- 109 · dual_control_pdp_backfill (T-0397) — close the PDP dual-control read-hole.
-- (Renumbered 108→109 at rebase reconciliation: 108_app_section.sql from a sibling
--  task (T-0540) merged to dev first, so this backfill takes the next free prefix.)
--
-- PROBLEM (verified): src/db/grants-dao.ts activated a capability grant on
-- `confirmed_by IS NOT NULL` ALONE — it ignored BOTH `confirmed2_by` AND
-- `valid_until` for the grant query, and the role_assignment query honored
-- `valid_until` but NOT `confirmed2_by`. A critical/escalating grant therefore
-- became PDP-active after the FIRST approver; the second approval (the durable
-- `confirmed2_by` column added in migration 031) was decorative for ACTIVATION.
-- This is a real authorization hole: dual-control was enforced on the WRITE side
-- (grants.ts lands escalating rows semi-confirmed, confirmed2_by = NULL) but the
-- READ/PDP side never checked it.
--
-- FIX (review B1 — fail-CLOSED across ALL axes): the PDP read-path (grants-dao.ts)
-- now requires `confirmed2_by IS NOT NULL` to ACTIVATE a CRITICAL grant/assignment,
-- and honors `valid_until` for the grant query too. "Critical" is the FULL
-- T-0040/T-0044 escalation classification (criticalGrantPredicate — a fail-closed
-- SQL superset of the write-side dualControlDecision over ALL FOUR axes):
--   axis a — operation IN ('approve','transition')   (guarded-transition ops)
--   axis b — resource_type = 'effect_resource' AND operation = 'invoke'
--   axis c — operation = 'read' with a SENSITIVE clearance marker (confidential|restricted)
--   Q-2   — operation = 'read' with a PRESENT-but-garbage clearance token (fail-closed)
-- The clearance marker is read constraint-first, resource_facet fallback (mirrors
-- data-classification.ts grantClearance). The original B1 read-hole was that the
-- read-side checked ONLY axes a/b: a read grant escalated by axis c / Q-2 landed
-- semi-confirmed write-side yet went PDP-active after ONE approver. This migration's
-- backfill predicate MUST therefore match the read predicate over ALL FOUR axes so
-- the tightening stays non-breaking for every axis (not just a/b).
-- An assignment is critical iff the role it binds holds any such critical grant.
--
-- ── THIS MIGRATION IS PURE BACKFILL — NO DDL ──────────────────────────────────
-- The `confirmed2_by` column already exists (migration 031). The enforcement
-- itself is the grants-dao.ts query change. This migration ONLY backfills
-- existing rows so the enforcement is NON-BREAKING for access that was
-- LEGITIMATELY active under the OLD rule.
--
-- ── BACKFILL SEMANTICS DECISION (engineering call, T-0397) ────────────────────
-- DECISION: For existing CRITICAL grants/assignments that are CURRENTLY ACTIVE
-- under the old rule (confirmed_by IS NOT NULL, not expired, confirmed2_by IS
-- NULL), set `confirmed2_by = confirmed_by` so they REMAIN active after the
-- read-path tightens.
--
-- RATIONALE (why grandfather rather than force re-confirm):
--   1. NON-BREAKING is the explicit task contract: tightening the PDP read must
--      not silently REVOKE access that was real and in-use yesterday. Leaving
--      confirmed2_by NULL would instantly deactivate every critical grant on
--      deploy — a fail-CLOSED outage for legitimately-granted approvers (e.g.
--      the seed budget-approver assignment, the TEL approver role grants). That
--      is a denial-of-service regression, not a security win.
--   2. AUDITABLE: setting confirmed2_by = confirmed_by makes the grandfathering
--      EXPLICIT and self-documenting in the row itself — an auditor sees that the
--      second confirmer equals the first (a backfilled, not independently-sourced,
--      second approval) and can reconcile it against this migration's version
--      stamp in schema_migrations. The alternative (a sentinel like
--      'backfill-T-0397') was considered; confirmed_by is preferred because the
--      column is already free-form text identity and downstream readers only test
--      NULL-ness — no reader parses the value, so a real id keeps FK-free joins
--      and audit reads clean while still being greppable via this migration.
--   3. GOING FORWARD the gate is REAL: NEW critical grants written after this
--      migration go through grants.ts → dualControlDecision, which lands them
--      semi-confirmed (confirmed2_by = NULL) until a genuine SECOND distinct
--      authenticated approver confirms (grants.ts confirmSecondApprover). The
--      backfill touches ONLY pre-existing rows; it does not weaken the new path.
--   4. SCOPE-MINIMAL: we backfill ONLY rows that were ACTIVE under the old rule
--      (confirmed_by set AND not expired). An already-expired or unconfirmed row
--      is NOT grandfathered — it was not active, so tightening cannot "break" it.
--
-- All statements are idempotent (WHERE confirmed2_by IS NULL) and re-run-safe.
-- RLS: this migration runs as choros_migrator (BYPASSRLS); every UPDATE is
-- explicitly tenant-agnostic ACROSS all tenants on purpose (a one-time global
-- grandfather), but each row's own tenant_id is preserved untouched — we never
-- move a row across tenants, and the WHERE clauses never join across tenant_id.

-- ── Backfill 1: critical GRANTS active under the old rule ─────────────────────
-- A grant is "critical" iff it matches ANY of the four axes (a/b/c/Q-2) — the
-- SAME criticalGrantPredicate the read-path now enforces (grants-dao.ts). We must
-- grandfather axis c / Q-2 rows too: under the OLD read rule those read grants were
-- PDP-active on confirmed_by alone, so leaving confirmed2_by NULL would deactivate
-- them on deploy (a fail-closed regression for legitimately-granted access).
-- "Active under old rule" = confirmed_by NOT NULL AND not expired at apply time.
-- valid_until is bigint epoch-ms (migration 008); compare against NOW() epoch-ms.
UPDATE choros."grant" g
   SET confirmed2_by = g.confirmed_by
 WHERE g.confirmed2_by IS NULL
   AND g.confirmed_by IS NOT NULL
   AND (
         -- axis a
         g.operation IN ('approve', 'transition')
         -- axis b
         OR (g.resource_type = 'effect_resource' AND g.operation = 'invoke')
         -- axis c + Q-2 — a READ grant with a sensitive OR garbage clearance marker.
         -- Clearance is read constraint-first, resource_facet fallback, using the
         -- jsonb key-exists `?` operator so a present-but-null token still counts.
         OR (
              g.operation = 'read'
              AND (
                    (g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance'))
                    OR (g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance'))
                  )
              AND (
                    COALESCE(
                      CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                           THEN g."constraint"->>'clearance' END,
                      CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                           THEN g.resource_facet->>'clearance' END
                    ) IN ('confidential', 'restricted')
                    OR COALESCE(
                      CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                           THEN g."constraint"->>'clearance' END,
                      CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                           THEN g.resource_facet->>'clearance' END
                    ) IS NULL
                    OR COALESCE(
                      CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                           THEN g."constraint"->>'clearance' END,
                      CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                           THEN g.resource_facet->>'clearance' END
                    ) NOT IN ('public', 'internal', 'confidential', 'restricted')
                  )
            )
       )
   AND (g.valid_until IS NULL
        OR g.valid_until > (EXTRACT(EPOCH FROM now()) * 1000)::bigint);

-- ── Backfill 2: role_assignments whose role holds a critical grant ────────────
-- An assignment is critical iff the role it binds holds ANY EFFECTIVE critical
-- grant (full four-axis predicate, same as backfill 1 and the read-path EXISTS).
-- We backfill confirmed2_by for assignments that were active under the old rule
-- (confirmed_by NOT NULL, not expired) and whose role carries a critical grant.
-- The criticizing grant is window-scoped (M1: an expired critical grant confers no
-- capability, so it must not criticize the assignment — matching the read-path).
-- tenant_id is matched on BOTH sides of the EXISTS so no cross-tenant edge is
-- introduced (NF-2: every join includes tenant_id).
UPDATE choros.role_assignment ra
   SET confirmed2_by = ra.confirmed_by,
       updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
 WHERE ra.confirmed2_by IS NULL
   AND ra.confirmed_by IS NOT NULL
   AND (ra.valid_until IS NULL
        OR ra.valid_until > (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
   AND EXISTS (
         SELECT 1
           FROM choros."grant" g
          WHERE g.tenant_id = ra.tenant_id
            AND g.role_id   = ra.role_id
            AND g.confirmed_by IS NOT NULL
            AND (g.valid_until IS NULL
                 OR g.valid_until > (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
            AND (
                  -- axis a
                  g.operation IN ('approve', 'transition')
                  -- axis b
                  OR (g.resource_type = 'effect_resource' AND g.operation = 'invoke')
                  -- axis c + Q-2 (read grant w/ sensitive or garbage clearance marker)
                  OR (
                       g.operation = 'read'
                       AND (
                             (g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance'))
                             OR (g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance'))
                           )
                       AND (
                             COALESCE(
                               CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                                    THEN g."constraint"->>'clearance' END,
                               CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                                    THEN g.resource_facet->>'clearance' END
                             ) IN ('confidential', 'restricted')
                             OR COALESCE(
                               CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                                    THEN g."constraint"->>'clearance' END,
                               CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                                    THEN g.resource_facet->>'clearance' END
                             ) IS NULL
                             OR COALESCE(
                               CASE WHEN g."constraint" IS NOT NULL AND jsonb_typeof(g."constraint") = 'object' AND (g."constraint" ? 'clearance')
                                    THEN g."constraint"->>'clearance' END,
                               CASE WHEN g.resource_facet IS NOT NULL AND jsonb_typeof(g.resource_facet) = 'object' AND (g.resource_facet ? 'clearance')
                                    THEN g.resource_facet->>'clearance' END
                             ) NOT IN ('public', 'internal', 'confidential', 'restricted')
                           )
                     )
                )
       );
