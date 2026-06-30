/**
 * src/db/grants-dao.ts — T-0331 (E15-S0a): Live DB getGrants DAO
 *
 * Reusable DAO that resolves an actor's CURRENT role slugs from the live DB
 * grant source (via role_assignment → role), replacing the in-memory
 * `rolesForUser` fixture in inbox.ts.
 *
 * Design:
 *  - Conforms to the `GrantSource` interface (grant-resolver.ts §3.2): returns
 *    the full `Grant[]` array via `getGrantsForSubject` so callers like the PDP
 *    can use it directly. The `getRoleSlugsForActor` helper is the thin projection
 *    needed by the inbox (role-slug set for pool-task filtering).
 *  - Tenant-isolation: every query runs inside a `SET LOCAL choros.tenant_id`
 *    transaction (RLS). Follows the withTenant pattern from src/db/org.ts.
 *  - Validity windows: every assignment/grant read filters by the half-open
 *    [valid_from, valid_until) window (bigint epoch-ms; NULL = unbounded). As of
 *    T-0397 the GRANT query honors valid_until too (it previously did not), so a
 *    grant past its valid_until is no longer PDP-active.
 *  - Dual-control (T-0397): a CRITICAL grant/assignment is PDP-active only when
 *    its SECOND distinct approver is present (confirmed2_by IS NOT NULL), not on
 *    confirmed_by alone. "Critical" is the FULL T-0040/T-0044 escalation
 *    classification (criticalGrantPredicate — a fail-CLOSED SQL superset of the
 *    write-side dualControlDecision over ALL FOUR escalation axes):
 *      axis a — operation ∈ {approve, transition}
 *      axis b — resource_type = effect_resource AND operation = invoke
 *      axis c — operation = read with a sensitive clearance marker (confidential|restricted)
 *      Q-2   — operation = read with a present-but-garbage clearance token
 *    An assignment is critical iff the role it binds holds any EFFECTIVE such grant.
 *    This closes the B1 read-path hole (review): the WRITE side (grants.ts) lands
 *    escalating rows semi-confirmed (confirmed2_by NULL = NOT active) on ALL axes,
 *    but the read side previously only checked axes a/b — so a read grant escalated
 *    by axis c / Q-2 went PDP-active after ONE approver. The gate now closes every
 *    axis. Non-critical grants/assignments keep their single-confirm behaviour.
 *  - Reuse design: `getGrantsForSubject` provides the full Grant[] path for S2
 *    (executor-resolution, T-0336) and S1 (resolveFor seam, T-0335).
 *
 * Tenant-RLS guard: tenant_id is UUID-validated before interpolation (mirrors
 * org.ts assertUuid pattern — defence-in-depth per T-0013 / T-0116 R-3).
 */

import pg from "pg";
import type { Grant } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";
import type { GrantSource } from "../core/grant-resolver.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";

// ---------------------------------------------------------------------------
// UUID shape guard (mirrors org.ts — defence-in-depth, T-0116 R-3)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// T-0397 — CRITICAL-grant SQL predicate (fail-CLOSED, all four escalation axes)
//
// A single SQL boolean expression that is TRUE iff a grant ROW carries a
// criticality the WRITE-side dual-control gate (src/core/dual-control.ts +
// role-criticality.ts) would escalate on — so the read-path can gate
// `confirmed2_by IS NOT NULL` on the SAME classification the write-side used to
// land the row semi-confirmed. This closes the original B1 hole: the read-side
// previously only checked axes a/b, so a `read`-operation grant escalated by
// axis c (sensitive clearance) or Q-2 (garbage clearance token) went PDP-active
// after ONE approver.
//
// THE FOUR AXES (mirrors combineCriticality + nonDerivableReadClearance EXACTLY):
//   axis a — operation IN ('approve','transition')                       (guarded-transition ops)
//   axis b — resource_type = 'effect_resource' AND operation = 'invoke'  (T-0034 gateway)
//   axis c — operation = 'read' AND the grant's clearance marker is a SENSITIVE
//            DataClass (rank >= 'confidential'): { clearance: confidential|restricted }.
//   Q-2   — operation = 'read' AND a `clearance` KEY is PRESENT but its value is
//            NOT a derivable DataClass (a garbage token) — fail-closed implicit
//            escalate (dual-control.ts nonDerivableReadClearance).
//
// CLEARANCE MARKER LOOKUP — mirrors data-classification.ts grantClearance:
//   the marker is read from "constraint" FIRST; "resource_facet" is the fallback
//   ONLY when "constraint" carries NO `clearance` KEY. We use the jsonb key-exists
//   operator `?` to distinguish "key absent" from "key present with JSON null"
//   (the latter is a present-but-garbage token → Q-2 escalates), matching the TS
//   readClearancePresence/readClearanceMarker presence semantics precisely.
//
// FAIL-CLOSED DISCIPLINE (NF-2): this read gate is a DEFENCE-IN-DEPTH SUPERSET of
// the write-side decision. The write-side (grants.ts → dualControlDecision) is the
// single SOURCE of truth that lands NEW critical rows semi-confirmed; this SQL is
// the read-side enforcement that the second approver actually gates ACTIVATION.
// Any ambiguity (corrupt clearance, present-but-null) resolves toward MORE control
// (treat as critical), never less — so the gate can only ever OVER-require the
// second approver, never silently activate an escalating grant on one approver.
//
// SINGLE SOURCE / NO DRIFT: this fragment is defined ONCE and interpolated into
// all three read predicates (grant query, both assignment EXISTS clauses + the
// role-slug JOIN). A db-integration test (grants-dao.integration.test.ts) pins the
// predicate against a REAL Postgres so it cannot silently diverge from the TS
// criticality axes. The fragment references the bare column names (operation,
// resource_type, "constraint", resource_facet) so it is valid both as a top-level
// WHERE clause (grant query) and inside the `g.`-aliased EXISTS sub-queries via a
// parametric alias.
// ---------------------------------------------------------------------------

/**
 * Build the CRITICAL-grant SQL predicate for a given column alias (e.g. "g" or
 * "" for the bare grant query). Returns a boolean SQL expression. Pure string
 * builder — no interpolation of user data (alias is a hard-coded caller constant).
 */
function criticalGrantPredicate(alias: string): string {
  const p = alias ? `${alias}.` : "";
  // Clearance marker, constraint-first with resource_facet fallback ONLY when
  // constraint carries no `clearance` key (mirrors grantClearance constraint-first).
  const clearanceValue = `(
        CASE
          WHEN ${p}"constraint" IS NOT NULL AND jsonb_typeof(${p}"constraint") = 'object'
               AND (${p}"constraint" ? 'clearance')
            THEN ${p}"constraint"->>'clearance'
          WHEN ${p}resource_facet IS NOT NULL AND jsonb_typeof(${p}resource_facet) = 'object'
               AND (${p}resource_facet ? 'clearance')
            THEN ${p}resource_facet->>'clearance'
          ELSE NULL
        END
      )`;
  // Is a `clearance` KEY present at all (constraint-first, then facet)? Uses the
  // jsonb key-exists `?` operator so a present-but-JSON-null value still counts as
  // present (→ Q-2 garbage token), exactly like readClearancePresence.
  const clearancePresent = `(
        (${p}"constraint" IS NOT NULL AND jsonb_typeof(${p}"constraint") = 'object' AND (${p}"constraint" ? 'clearance'))
        OR (${p}resource_facet IS NOT NULL AND jsonb_typeof(${p}resource_facet) = 'object' AND (${p}resource_facet ? 'clearance'))
      )`;
  return `(
        -- axis a — guarded-transition op-class
        ${p}operation IN ('approve', 'transition')
        -- axis b — T-0034 external-effect gateway
        OR (${p}resource_type = 'effect_resource' AND ${p}operation = 'invoke')
        -- axis c + Q-2 — a READ grant carrying a sensitive OR garbage clearance marker
        OR (
              ${p}operation = 'read'
              AND ${clearancePresent}
              AND (
                    -- axis c: sensitive DataClass (rank >= 'confidential')
                    ${clearanceValue} IN ('confidential', 'restricted')
                    -- Q-2: present clearance KEY whose value is NOT a derivable
                    -- DataClass token — a garbage/non-string/JSON-null value (the
                    -- text extraction is NULL for JSON null) is fail-closed critical.
                    OR ${clearanceValue} IS NULL
                    OR ${clearanceValue} NOT IN ('public', 'internal', 'confidential', 'restricted')
                  )
           )
      )`;
}

// The bare-column form (grant query top-level WHERE) and the g-aliased form
// (assignment EXISTS sub-queries) — built once, reused everywhere (no drift).
const CRITICAL_GRANT_PREDICATE_BARE = criticalGrantPredicate("");
const CRITICAL_GRANT_PREDICATE_G = criticalGrantPredicate("g");

// ---------------------------------------------------------------------------
// withTenantReadTx — tenant-scoped read transaction (mirrors org.ts withTenant)
// ---------------------------------------------------------------------------

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// getGrantsForSubject — full Grant[] from live DB (GrantSource interface shape)
//
// Loads confirmed, in-window role_assignments for the subject (by employee slug),
// then fetches confirmed grants for those roles.
//
// This is the reusable foundation for:
//   S0a (T-0331): role-slug DAO for inbox.ts
//   S1 (T-0335):  resolveFor seam (applier needs grant PDP)
//   S2 (T-0336):  executor resolution via PDP claim-check
//
// `nowMs` is used for validity-window filtering: NULL valid_from = effective
// from the start; NULL valid_until = no end. Half-open window [from, until).
// This mirrors grant-resolver.ts isEffective semantics exactly.
// ---------------------------------------------------------------------------

export async function getGrantsForSubject(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number,
): Promise<Grant[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Step 1: resolve actor slug → employee id (within tenant, RLS-scoped).
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorSlug],
    );
    if (empRows.length === 0) {
      // Unknown actor → no grants (fail open to empty, not an error).
      return [];
    }
    const employeeId = empRows[0]!.id;

    // Step 2: load ACTIVE role_assignments for the employee.
    // confirmed_by IS NOT NULL = confirmed (NF per migration 020 contract).
    // valid_from/until window: NULL = unbounded on that side.
    //
    // T-0397 — dual-control on the assignment too: an assignment is CRITICAL iff
    // the role it binds holds any EFFECTIVE critical grant (all four axes, same
    // criticalGrantPredicate as the grant query). A critical assignment is
    // PDP-active only when its second approver is present (confirmed2_by IS NOT
    // NULL). Non-critical assignments keep single-confirm. The criticality EXISTS
    // is tenant-scoped on BOTH sides (g.tenant_id = ra.tenant_id) — no cross-tenant
    // edge (NF-2) — AND window-scoped on the grant (M1 review fix): an expired
    // critical grant confers no capability, so it must not criticize the assignment.
    const { rows: raRows } = await client.query<{ role_id: string }>(
      `SELECT ra.role_id
         FROM choros.role_assignment ra
        WHERE ra.tenant_id = $1
          AND ra.employee_id = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND (
                ra.confirmed2_by IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1 FROM choros."grant" g
                   WHERE g.tenant_id = ra.tenant_id
                     AND g.role_id   = ra.role_id
                     AND g.confirmed_by IS NOT NULL
                     -- M1: only an EFFECTIVE (in-window) critical grant criticizes
                     -- the assignment; an expired critical grant confers zero
                     -- capability (combineCriticality counts effective grants only),
                     -- so it must not force the assignment's second-approver gate.
                     AND (g.valid_from  IS NULL OR g.valid_from  <= $3)
                     AND (g.valid_until IS NULL OR g.valid_until  > $3)
                     AND ${CRITICAL_GRANT_PREDICATE_G}
                )
              )`,
      [tenantId, employeeId, nowMs],
    );
    if (raRows.length === 0) {
      return [];
    }
    const roleIds = raRows.map((r) => r.role_id);

    // Step 3: load ACTIVE grants for those roles.
    //
    // T-0397 — PDP dual-control read-path enforcement. A grant is PDP-active iff:
    //   (1) confirmed_by IS NOT NULL                (first approver — migration 030/031), AND
    //   (2) it is in its validity window            (valid_from/valid_until — migration 008,
    //       previously IGNORED for grants → now honored, matching the role_assignment
    //       query and grant-resolver.ts isEffective), AND
    //   (3) if it is CRITICAL, confirmed2_by IS NOT NULL (second distinct approver —
    //       migration 031 dual-control contract). Before T-0397 this column was
    //       written by grants.ts on the WRITE side (escalating rows land semi-
    //       confirmed, confirmed2_by NULL = NOT active) but NEVER checked on the
    //       READ side, so a critical grant went PDP-active after ONE approver.
    //
    // "Critical" is the FULL T-0040/T-0044 escalation classification a single grant
    // row can carry (criticalGrantPredicate — fail-closed superset of the write-side
    // dualControlDecision over ALL FOUR axes; see its header):
    //   axis a — operation IN ('approve','transition')
    //   axis b — resource_type = 'effect_resource' AND operation = 'invoke'
    //   axis c — operation = 'read' with a sensitive clearance marker (confidential|restricted)
    //   Q-2   — operation = 'read' with a PRESENT-but-garbage clearance token (fail-closed)
    // B1 FIX (review): the prior predicate checked ONLY axes a/b, so a read grant
    // escalated by axis c / Q-2 landed semi-confirmed write-side (confirmed2_by NULL)
    // yet the read gate treated it as non-critical → ACTIVE after one approver. The
    // predicate now closes every axis fail-CLOSED.
    //
    // valid_from/until are bigint epoch-ms (NULL = unbounded); half-open [from, until).
    const { rows: grantRows } = await client.query<{
      id: string;
      role_id: string;
      resource_type: string;
      resource_facet: unknown;
      operation: string;
      scope: unknown;
      constraint: unknown;
      delegable: boolean;
      granted_by: string;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string;
    }>(
      `SELECT id, role_id, resource_type, resource_facet,
              operation, scope, "constraint", delegable,
              granted_by, valid_from, valid_until, created_at
         FROM choros."grant"
        WHERE tenant_id = $1
          AND role_id = ANY($2::uuid[])
          AND confirmed_by IS NOT NULL
          AND (valid_from  IS NULL OR valid_from  <= $3)
          AND (valid_until IS NULL OR valid_until  > $3)
          AND (
                NOT ${CRITICAL_GRANT_PREDICATE_BARE}
                OR confirmed2_by IS NOT NULL
              )`,
      [tenantId, roleIds, nowMs],
    );

    return grantRows.map((g) => ({
      tenantId,
      id: g.id,
      roleId: g.role_id,
      resourceType: g.resource_type as Grant["resourceType"],
      resourceFacet: g.resource_facet ?? undefined,
      operation: g.operation as Grant["operation"],
      scope: g.scope as Grant["scope"],
      constraint: g.constraint ?? undefined,
      delegable: g.delegable,
      grantedBy: g.granted_by,
      validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
      validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
      createdAt: Number(g.created_at),
    }));
  });
}

// ---------------------------------------------------------------------------
// makeDbGrantSource — build a GrantSource from a pool for use with the PDP
// (grant-resolver.ts ResolverDeps.grants interface).
//
// The GrantSource.getGrants interface takes a ResolveSubject (tenantId +
// subjectId = employee slug) and nowMs, so it maps cleanly to getGrantsForSubject.
// This is the reuse seam for S1 / S2 — the inbox uses getRoleSlugsForActor
// directly; the PDP uses makeDbGrantSource.
// ---------------------------------------------------------------------------

export function makeDbGrantSource(pool: pg.Pool): GrantSource {
  return {
    async getGrants(subject: ResolveSubject, nowMs: number): Promise<Grant[]> {
      return getGrantsForSubject(pool, subject.tenantId, subject.subjectId, nowMs);
    },
  };
}

// ---------------------------------------------------------------------------
// getRoleSlugsForActor — projection: actor's confirmed, in-window role slugs
//
// The thin projection the inbox.ts `rolesForUser` replacement needs: given an
// actor slug, returns the set of role slugs (e.g. ["fin-ctrl", "role-approver"])
// that actor holds via confirmed, in-window role_assignments.
//
// Role slugs are used by the inbox for pool-task filtering (tab "Из пула") and
// the claim/approve eligibility gate. They are NOT used for PDP decisions —
// that path goes through getGrantsForSubject → resolveFor.
//
// Returns [] (empty array) for an unknown actor (no employee row, no assignments,
// or no valid roles) — the same sentinel as the in-memory rolesForUser fallback.
//
// T-0366 — fallback slug for KC seed personas:
//   Under Keycloak auth mode, the KC JWT `sub` is a random UUID that does
//   not match employee.slug for seed dev personas (e.g. e-larina.slug='e-larina'
//   but KC sub='f4a5f440-…'). The optional `fallbackSlug` param (preferred_username
//   from the JWT) is tried ONLY when the primary lookup returns no employee row.
//
//   Security invariant: primary is ALWAYS tried first and short-circuits — the
//   fallback is never consulted for registered users (slug == sub, so primary hits).
//   The fallback only activates when the primary slug matches NO employee, which
//   happens exclusively for seed personas whose KC sub was not set from their slug.
// ---------------------------------------------------------------------------

export async function getRoleSlugsForActor(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number = Date.now(),
  fallbackSlug?: string,
): Promise<string[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Resolve actor slug → employee id.
    // T-0366: try primary first; if no row AND fallback is provided (and distinct),
    // try the fallback slug. The primary short-circuits so registered users
    // (slug == sub) never reach the fallback path — no impersonation risk.
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorSlug],
    );

    let employeeId: string;
    if (empRows.length > 0) {
      employeeId = empRows[0]!.id;
    } else if (fallbackSlug !== undefined && fallbackSlug !== actorSlug) {
      // Primary slug matched no employee — try the fallback (preferred_username).
      const { rows: fbRows } = await client.query<{ id: string }>(
        `SELECT id FROM choros.employee
          WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [tenantId, fallbackSlug],
      );
      if (fbRows.length === 0) {
        return [];
      }
      employeeId = fbRows[0]!.id;
    } else {
      return [];
    }

    // Confirmed, in-window assignments → role slugs in one join.
    //
    // T-0397 — same dual-control gate as getGrantsForSubject step 2: a CRITICAL
    // assignment (role holds an EFFECTIVE critical grant under any of the four
    // axes, criticalGrantPredicate) contributes its role slug to the inbox
    // eligibility set ONLY when confirmed2_by IS NOT NULL. This keeps the
    // claim/approve eligibility gate consistent with the PDP grant read.
    const { rows } = await client.query<{ slug: string }>(
      `SELECT DISTINCT r.slug
         FROM choros.role_assignment ra
         JOIN choros.role r
           ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND (
                ra.confirmed2_by IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1 FROM choros."grant" g
                   WHERE g.tenant_id = ra.tenant_id
                     AND g.role_id   = ra.role_id
                     AND g.confirmed_by IS NOT NULL
                     -- M1: window-scope the criticizing grant (see getGrantsForSubject).
                     AND (g.valid_from  IS NULL OR g.valid_from  <= $3)
                     AND (g.valid_until IS NULL OR g.valid_until  > $3)
                     AND ${CRITICAL_GRANT_PREDICATE_G}
                )
              )`,
      [tenantId, employeeId, nowMs],
    );
    return rows.map((r) => r.slug);
  });
}

// ---------------------------------------------------------------------------
// getHoldersForRole — T-0380 (D4): role → employee slugs (executor-resolver
// RoleHolderSource backing). Given a role SLUG, returns the confirmed,
// in-window employee slugs assigned to that role. This is the reverse of
// getRoleSlugsForActor (actor → roles) — here we go role → actors.
//
// Used by makeDbRoleHolderSource in executor-resolver.ts for the role-pool step.
// ---------------------------------------------------------------------------

export async function getHoldersForRole(
  pool: pg.Pool,
  tenantId: string,
  roleSlug: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ slug: string }>(
      `SELECT DISTINCT e.slug
         FROM choros.employee e
         JOIN choros.role_assignment ra ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id
         JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE e.tenant_id = $1
          AND r.slug = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
      [tenantId, roleSlug, nowMs],
    );
    return rows.map((r) => r.slug);
  });
}

// ---------------------------------------------------------------------------
// findTenantOwnerSlug — T-0380 (D4): resolve the slug of the employee holding
// the 'tenant-owner' role in this tenant.
//
// Used by the executor-resolver fallback-owner path (F6/PD-10): when a step's
// role has no confirmed holders and no substitution applies, the task is routed
// to the tenant owner. Returns null when no owner row is found (fresh tenant
// with no seed; callers should treat null as "route to system / no assignee").
//
// Mirrors the isGenesisOwnerForTenant query pattern in src/db/org.ts, scoped
// to return the slug rather than a boolean.
// ---------------------------------------------------------------------------

export async function findTenantOwnerSlug(
  pool: pg.Pool,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ slug: string }>(
      `SELECT e.slug
         FROM choros.employee e
         JOIN choros.role_assignment ra ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id
         JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE e.tenant_id = $1
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $2)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $2)
        LIMIT 1`,
      [tenantId, nowMs],
    );
    return rows.length > 0 ? (rows[0]!.slug) : null;
  });
}

// ---------------------------------------------------------------------------
// getAuthoringDraftHolderEmployeeIds — T-0466 (D8-G5): resolve the EMPLOYEE IDs
// of HUMAN employees who hold a confirmed, in-window `authoring_draft` grant.
//
// These are exactly the admins/owners who CAN act on the authoring sandbox, so
// they are the right recipients for a non-admin's config-request (заявка на
// настройку): the capture-as-request path (assistant.ts) files a notification to
// each of them. Reuses the grant model (no new role concept). kind='human' so we
// never notify agent employees (e.g. assistant-agent, config-agent-seed), who
// also hold the grant but cannot read a notification center.
//
// Returns employee UUIDs (NOT slugs) because choros.notification.recipient_id is
// uuid with FK → employee(tenant_id, id) (migration 046). Empty when no human
// holder exists (callers fall back to the tenant owner).
// ---------------------------------------------------------------------------

export async function getAuthoringDraftHolderEmployeeIds(
  pool: pg.Pool,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT DISTINCT e.id
         FROM choros.employee e
         JOIN choros.role_assignment ra
              ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id
         JOIN choros."grant" g
              ON g.tenant_id = ra.tenant_id AND g.role_id = ra.role_id
        WHERE e.tenant_id = $1
          AND e.kind = 'human'
          AND g.resource_type = 'authoring_draft'
          AND g.confirmed_by IS NOT NULL
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $2)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $2)
          AND (g.valid_from  IS NULL OR g.valid_from  <= $2)
          AND (g.valid_until IS NULL OR g.valid_until  > $2)`,
      [tenantId, nowMs],
    );
    return rows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------------------
// findTenantOwnerEmployeeId — T-0466 (D8-G5): the EMPLOYEE ID of the tenant
// owner (fallback recipient when no explicit authoring_draft holder exists).
// Mirrors findTenantOwnerSlug but returns the UUID for notification.recipient_id.
// ---------------------------------------------------------------------------

export async function findTenantOwnerEmployeeId(
  pool: pg.Pool,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT e.id
         FROM choros.employee e
         JOIN choros.role_assignment ra ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id
         JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE e.tenant_id = $1
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $2)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $2)
        LIMIT 1`,
      [tenantId, nowMs],
    );
    return rows.length > 0 ? rows[0]!.id : null;
  });
}

// ---------------------------------------------------------------------------
// getFieldVisibilityPolicy — T-0419 (D7-3-FU): derive FieldVisibilityPolicy
// from data_classification rows for a tenant (T-0081 / ADR §4.1).
//
// The FieldVisibilityPolicy.roleScopedFields is the set of JSONB field names
// whose visibility is per-role-scoped. These are the fields classified as
// 'confidential' or 'restricted' in data_classification — the two classes
// where a caller's role must EXPLICITLY confer the field (facet narrowing)
// to see it. 'public' and 'internal' fields remain on the union-floor
// (whole-resource semantics; most-restrictive post-filter does not hide them).
//
// NO new store: data_classification (migration 017) already exists and is
// RLS-isolated per tenant. This function is the edge-layer assembly described
// in T-0081 ADR §4.1 / §11. No migration required.
//
// Honest-degrade: if the tenant has no data_classification rows (typical for
// a fresh tenant or one that has not classified any fields), roleScopedFields
// is empty → policy is a no-op (NF-1, byte-identical to pre-T-0419).
// ---------------------------------------------------------------------------

export async function getFieldVisibilityPolicy(
  pool: pg.Pool,
  tenantId: string,
): Promise<FieldVisibilityPolicy> {
  const roleScopedFields = await withTenantReadTx(pool, tenantId, async (client) => {
    // Query all data_classification rows for the tenant (RLS-scoped).
    // Fields classified as 'confidential' or 'restricted' are role-scoped:
    // they are only visible when the actor's covering grant EXPLICITLY confers
    // them (via resourceFacet.fields). 'public' and 'internal' fields use the
    // union-floor (whole-resource semantics — not role-scoped).
    const { rows } = await client.query<{ facet_field: string }>(
      `SELECT DISTINCT facet_field
         FROM choros.data_classification
        WHERE tenant_id = $1
          AND class IN ('confidential', 'restricted')`,
      [tenantId],
    );
    return new Set(rows.map((r) => r.facet_field));
  });

  return { roleScopedFields };
}

// ---------------------------------------------------------------------------
// filterProvisionedAgentEmployeeIds — [SECURITY def-in-depth, publish-time]:
// resolve a set of candidate executor ids (authored choros:agentRef values) to
// the subset that are PROVISIONED agents in this tenant — i.e. a kind='agent'
// employee row WITH an agent_card row, scoped to `tenantId` (RLS-isolated read).
//
// Used by the process-publish path (process-defs.ts) to reject an authored
// agentTask whose choros:agentRef names a non-existent / non-agent / cross-tenant
// id BEFORE deploy. The pure publish transform (agent-task-external-mapper.ts)
// stamps the ref verbatim as the dispatcher's agentEmployeeId, and the pure (and
// IO-free) bpmn-linter only checks the ref is PRESENT — neither verifies it
// resolves. This DB-backed reader is that missing resolution, kept OUT of the
// pure transform/linter (which must stay side-effect-free) and in the DB layer.
//
// agent_card's FK pins employee_kind='agent' (migration 032), so an agent_card
// row already implies kind='agent'; we still JOIN employee + assert e.kind='agent'
// for an explicit, resilient guarantee and to confirm the employee row exists.
// Org-less / system agents (NULL agent_card.employee_id, migration 093) are
// addressed by their agent_card id — NOT an employee id — so they never match
// here, which is correct: an org-less agent holds no process role and is not a
// valid agentTask executor (agent-task-external-mapper.ts header).
//
// Returns the subset of `ids` that resolve (a Set for O(1) membership at the call
// site). Inputs are deduped and filtered to well-formed UUIDs up-front: a non-UUID
// id can never match the uuid employee.id column, so it is inherently unresolved
// (the caller rejects it) — filtering avoids letting Postgres throw on an invalid
// uuid cast inside the ANY($2::uuid[]) array.
// ---------------------------------------------------------------------------

export async function filterProvisionedAgentEmployeeIds(
  pool: pg.Pool,
  tenantId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const candidateIds = Array.from(new Set(ids)).filter((id) => UUID_RE.test(id));
  if (candidateIds.length === 0) return new Set<string>();

  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT e.id
         FROM choros.employee e
         JOIN choros.agent_card ac
           ON ac.tenant_id = e.tenant_id AND ac.employee_id = e.id
        WHERE e.tenant_id = $1
          AND e.kind = 'agent'
          AND e.id = ANY($2::uuid[])`,
      [tenantId, candidateIds],
    );
    return new Set<string>(rows.map((r) => r.id));
  });
}
