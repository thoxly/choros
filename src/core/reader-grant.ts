/**
 * src/core/reader-grant.ts — T-0583 (ADR-T0583-user-mgmt §5, contract
 * FE-W23-0008): shared extraction of the T-0619 hire-flow reader-grant helper.
 *
 * WHY EXTRACTED. `ensureReaderRoleAndAssignHuman` was a PRIVATE function in
 * src/http/rights-intents.ts (T-0619, ADR-T0619 §2.1) — it idempotently
 * ensures role-reader (+ its covering RESOURCE_ROOT READ grant) exists in a
 * tenant and assigns a hired HUMAN employee to it, so the hired person can
 * immediately read records (getGrantsForSubject → covering read/record grant).
 *
 * T-0583 needs the IDENTICAL behaviour when a per-tenant "create user account"
 * (POST /api/users, src/http/user-mgmt.ts) mints a new employee — the created
 * account must be readable-from-day-one, same as a hire. Rather than
 * duplicating the SQL (a second point of drift on the role-reader shape), this
 * module is the SINGLE shared implementation; BOTH callers
 * (src/http/rights-intents.ts registerHire AND src/http/user-mgmt.ts) import
 * and call this one function.
 *
 * rights-intents.ts keeps its OWN re-export of the name (see bottom of that
 * file) so its public surface (registerHire, etc.) is UNCHANGED — this is a
 * pure move-and-import, not a behavioural change (FF-583-10 / hire-read-grant
 * .db.test.ts must stay green verbatim).
 *
 * BOUNDARIES (security — do NOT widen, ADR-T0619 §2.2/§2.3, unchanged here):
 *   - role-reader is baseline "sees records + readable fields" only: a
 *     read/record grant on the RESOURCE_ROOT sentinel with resource_facet=NULL
 *     (whole-resource at the RECORD-VISIBILITY level). It does NOT bypass
 *     field-visibility — applyFieldVisibilityRedaction (records.ts) still
 *     redacts hidden fields INDEPENDENTLY on top (composite gate). It is a
 *     covering READ on RESOURCE_ROOT exactly like the owner's, NOT a super-grant.
 *   - Only humans. Business agents get read via THEIR OWN grants (a separate
 *     agent-rights circuit); this helper must never be called for kind='agent'.
 *   - Idempotent: role/grant use ON CONFLICT DO NOTHING / WHERE NOT EXISTS, and
 *     the assignment is guarded by WHERE NOT EXISTS on
 *     (tenant_id, employee_id, role_id) so calling this twice for the same
 *     human (e.g. hire then a later user-mgmt path, or vice versa) never
 *     plants a duplicate reader assignment.
 *
 * Mirrors register.ts 3m/3n and migration 117 blocks A/B/D — same role slug,
 * same grant shape, same RESOURCE_ROOT sentinel scope. No new table/column.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { READER_ROLE_SLUG, RESOURCE_ROOT_NODE_ID } from "./read-visibility.js";

/**
 * ensureReaderRoleAndAssignHuman — idempotently ensure role-reader (+ its
 * covering RESOURCE_ROOT READ grant) exists in `tenantId`, then assign
 * `humanEmployeeId` to it (CONFIRMED). Must run INSIDE the caller's existing
 * transaction (same `client`) so a rolled-back caller leaves no orphan reader
 * assignment. Call ONLY for kind='human' employees.
 */
export async function ensureReaderRoleAndAssignHuman(
  client: pg.PoolClient,
  tenantId: string,
  humanEmployeeId: string,
  actorId: string,
  nowMs: number,
): Promise<void> {
  // 1. Ensure the role-reader role exists (idempotent; register.ts / migration
  //    117 already created it for tenants that have an owner-seed).
  await client.query(
    `INSERT INTO choros.role
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'Читатель (по умолчанию)', $4, $4)
     ON CONFLICT (tenant_id, slug) DO NOTHING`,
    [tenantId, randomUUID(), READER_ROLE_SLUG, nowMs],
  );

  const { rows: roleRows } = await client.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, READER_ROLE_SLUG],
  );
  const readerRoleId = roleRows[0]!.id;

  // 2. Ensure the covering READ grant (read/record, RESOURCE_ROOT sentinel,
  //    resource_facet=NULL, delegable, confirmed) exists on role-reader
  //    (idempotent WHERE NOT EXISTS — byte-identical shape to register.ts 3p /
  //    migration 117 block D). One default-open READ grant per tenant, ever.
  const readScope = JSON.stringify({
    kind: "node",
    hierarchy: "resource",
    nodeLevel: "application",
    nodeId: RESOURCE_ROOT_NODE_ID,
  });
  await client.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     SELECT $1, $2, $3, 'record', NULL, 'read', $4::jsonb,
            NULL, true, 'intent:hire', NULL, 'intent:hire',
            NULL, NULL, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM choros."grant" g
         WHERE g.tenant_id = $1
           AND g.role_id = $3
           AND g.resource_type = 'record'
           AND g.operation = 'read'
           AND g.scope = $4::jsonb
      )`,
    [tenantId, randomUUID(), readerRoleId, readScope, nowMs],
  );

  // 3. Assign the human to role-reader (CONFIRMED, routine: proposed_by
  //    NULL, confirmed_by=actor — a role assignment never escalates the role's
  //    grant set, so it lands active per T-0605). Idempotent WHERE NOT EXISTS on
  //    (tenant_id, employee_id, role_id) — role_assignment carries no natural
  //    unique key (migration 020), same self-guard migration 117 block B uses.
  await client.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        granted_by, confirmed_by, source, created_at, updated_at)
     SELECT $1, $2, $3, $4, $5::jsonb, $6, $6, 'intent:hire', $7, $7
      WHERE NOT EXISTS (
        SELECT 1 FROM choros.role_assignment ra
         WHERE ra.tenant_id = $1
           AND ra.employee_id = $3
           AND ra.role_id = $4
      )`,
    [
      tenantId,
      randomUUID(),
      humanEmployeeId,
      readerRoleId,
      JSON.stringify({ kind: "set", members: [] }),
      actorId,
      nowMs,
    ],
  );
}
