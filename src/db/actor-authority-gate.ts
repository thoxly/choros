/**
 * src/db/actor-authority-gate.ts — T-0662 [security/системный анти-рецидив, столп 4]
 *
 * SINGLE NAMED deactivation predicate for authority actor-resolution.
 *
 * WHY THIS EXISTS (T-0658 §3.7 → T-0662):
 *   T-0658 closed the deactivated-employee authority hole in FIVE bespoke
 *   actor→authority resolvers, each patched separately with the same SQL
 *   predicate `AND deactivated_at IS NULL`. Five copies of one predicate is the
 *   symptom of NO single identity/deactivation layer: every new authority path
 *   must remember the predicate; forget once → the hole reopens (whack-a-mole).
 *
 *   This module is the STRUCTURAL anti-recurrence seam. It does NOT change any
 *   behaviour — the SQL is byte-identical to what the five sites already carry.
 *   It gives the predicate ONE NAME so that:
 *     (1) there is a single source of truth for "what does active mean" (a future
 *         change to the deactivation rule edits ONE constant, not five call
 *         sites), and
 *     (2) `ci/checks/actor-authority-deactivation-gate.sh` has a STABLE marker to
 *         anchor on — the fitness gate enforces that every registered authority
 *         actor-resolver carries `deactivated_at IS NULL` (this exact text), and
 *         a NEW bespoke authority `slug=$` employee-lookup without it turns CI
 *         red BEFORE merge.
 *
 * WHAT IS AN "AUTHORITY ACTOR-RESOLVER" (needs this predicate):
 *   A query that resolves an ACTOR's slug → employee id and feeds that id into a
 *   grant / role / owner / admin AUTHORIZATION decision. The registry (kept in
 *   sync with the fitness gate's AUTHORITY_RESOLVERS list):
 *     A  getGrantsForSubject            src/db/grants-dao.ts      (grant PDP)
 *     B1 isGenesisOwnerForTenant        src/db/org.ts             (owner short-circuit)
 *     B2 loadAdminContext               src/db/org.ts             (admin ctx + mgmt_object:* delegation)
 *     C  defaultCheckReadGrant          src/http/report-page-render.ts (report-page read-authz)
 *     D  registerSelfAbsence            src/http/rights-intents.ts (self-absence actor + Tier-2 mint)
 *
 * WHAT IS **NOT** AN AUTHORITY RESOLVER (this predicate MUST NOT be added — see
 * ADR-T0658 §3.4 / T-0662 ADR §1.1):
 *   - DISPLAY / identity-mapping: resolveActorSlugFromAuth,
 *     humanEmployeeSlugExistsOnClient (org.ts), actor-resolver.ts batch display,
 *     org.ts display lists. Resolving a NAME / existence for rendering or
 *     sub→slug AUTH must NOT require the subject be active — gating here would
 *     break showing a fired actor's name AND the OWNER's own re-activation path
 *     (PATCH /api/users resolves the acting owner via the same mapping).
 *   - CONSTRAINT (SoD): gating would SUBTRACT a deactivated subject's
 *     assignments → "no SoD violation" = fail-OPEN for a restriction.
 *   - write-target existence by id (`WHERE e.id = $`): resolves the TARGET row,
 *     not the authorizing ACTOR.
 *
 * AGENT SAFETY: `deactivated_at` (migration 125) is written ONLY by
 * PATCH /api/users, which is structurally restricted to kind='human' (404
 * otherwise). agent_card (migration 032) has no deactivation column. So a
 * kind='agent' employee's deactivated_at is always NULL in practice — this
 * predicate is a permanent no-op for agents and never filters a legitimate one.
 */

/**
 * The canonical "actor is active" SQL predicate, applied to the `choros.employee`
 * row an authority resolver resolves an ACTOR to. Interpolate into a WHERE clause
 * that already qualifies the employee row (bare column reference — no table alias
 * — so it composes with both `WHERE ... slug = $2 AND ${ACTOR_ACTIVE_SQL}` and a
 * predicate list). This is a STATIC constant, never a template of user input:
 * safe to string-concatenate into SQL.
 *
 * INVARIANT (T-0662): this exact literal `deactivated_at IS NULL` is the marker
 * `ci/checks/actor-authority-deactivation-gate.sh` greps for in every registered
 * authority resolver. Do NOT reword it (e.g. `deactivated_at ISNULL`,
 * `NOT (deactivated_at IS NOT NULL)`) without updating the gate in lockstep.
 */
export const ACTOR_ACTIVE_SQL = "deactivated_at IS NULL" as const;
