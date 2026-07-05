/**
 * src/http/rights-intents.ts — T-0223 (D-2): Everyday rights as INTENT operations.
 *
 * Implements the four named intent operations from the T-0222 ADR as a thin
 * orchestration layer over the existing rights kernel. The admin expresses a
 * single high-level INTENT; the system deterministically expands it into the
 * underlying primitive writes. NO new authority subsystem, NO new table/column,
 * NO new lattice algebra — every mechanism binds to a primitive that already
 * exists in dev (T-0018/T-0030/T-0035/T-0042/T-0136/T-0068).
 *
 * Routes (all additive, registered by registerRightsIntentRoutes):
 *   POST /api/rights/intents/hire            — add employee → position(preset) + issue preset grants
 *   POST /api/rights/intents/fire            — atomic revoke of ALL authority (+ reassign seam)
 *   POST /api/rights/intents/substitute      — T-0035 Tier-2 delegated SUBSET (subset-gated)
 *   POST /api/rights/intents/urgent-revoke   — immediate revoke (+ agent-step-halt seam)
 *
 * The explain-PDP card embed (invariant I-3) reuses the EXISTING
 * POST /api/pdp/explain endpoint (T-0136) verbatim — no new explain route here;
 * the web employee card calls it and the anti-oracle / mgmt-grant gate is enforced
 * by pdp-explain.ts. This module never re-implements the explain authz.
 *
 * ── Rule-9 seam vs T-0224 (preset DEFINITIONS) ──────────────────────────────
 * This module NEVER defines or mutates preset data. `hire` and `substitute`
 * consume DICT_PRESETS by READING the exported constant from grants.ts (T-0135);
 * T-0224 owns the seed preset-role set. A preset referenced by an unknown key
 * degrades to 404 PRESET_NOT_FOUND (the seed lands separately) — never invents one.
 *
 * ── The four load-bearing invariants (ADR §4) ──────────────────────────────
 *   I-1 intent→preset→grants — hire issues grants ONLY by expanding a
 *       GrantPreset.grants[] atom (provenance: granted_by="intent:hire:<presetId>").
 *       No raw-atom authoring path is exposed.
 *   I-2 substitution ⊆ substituted — every Tier-2 mint passes
 *       validateNarrowing(parentGrant, ttlChildGrant, oracle) at write-time;
 *       a widening substitution is REJECTED before persistence (substitution-widens
 *       → 422), never audited-after. delegable=false on the mint.
 *   I-3 explain behind mgmt-grant — delegated to POST /api/pdp/explain (T-0136).
 *   I-4 audit-per-action — every intent op folds to ≥1 event on the SINGLE
 *       canonical sink (appendAuditEvent via the T-0031 encoders), inside the
 *       same withTenantTx as the authority write. No parallel audit path.
 *
 * Frozen discipline: grant-lattice.ts (validateNarrowing) is CALLED, never
 * modified; DICT_PRESETS is READ, never edited; src/http/grants.ts is not edited.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  type Grant,
  type ScopeElement,
  validateNarrowing,
  isEffective,
  normalize,
} from "../core/grant-lattice.js";
import { eligibleForTier2 } from "../core/substitution.js";
import { combineCriticality } from "../core/role-criticality.js";
import { validateAdminDelegation } from "../core/scoped-admin.js";
import { loadAdminContext } from "../db/org.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import {
  encodeGrantAuditEvent,
  encodeAssignmentAuditEvent,
  type AuditEventInput,
} from "../core/audit-grant-encoder.js";
import { DICT_PRESETS, type GrantPreset, type GrantPresetAtom } from "./grants.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { ensureReaderRoleAndAssignHuman } from "../core/reader-grant.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

const intentAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// withTenantTx — write-path transaction (mirrors grants.ts / agents.ts; each
// keeps its own copy so the files stay disjoint — no shared private helper).
// The fire intent encloses its ENTIRE revoke loop in ONE withTenantTx so a
// partial fire cannot leave residual authority (FF-FIRE-2: per-principal atomic).
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
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
// ensureReaderRoleAndAssignHuman — T-0619 (ADR-T0619 §2.1, fix over T-0570).
//
// EXTRACTED (T-0583, ADR-T0583-user-mgmt §5, contract FE-W23-0008): this used
// to be a private function defined HERE. It now lives in
// src/core/reader-grant.ts as the SINGLE shared implementation, imported by
// BOTH this module (registerHire, below) and src/http/user-mgmt.ts (per-tenant
// "create user account"), so the two callers can never drift on the
// role-reader shape. Behaviour is UNCHANGED — see reader-grant.ts for the full
// rationale/boundaries (§2.2/§2.3) this move preserves verbatim.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// extractActor — mode-aware caller identity (T-0489 / T-0372 pattern).
//
// keycloak mode: getAuthContext is populated (withAuth ran first); resolve the
//   JWT `sub` (KC user UUID) → employee slug via resolveActorSlugFromAuth
//   (kind='human' only). null ⇒ fail closed (401) — the raw sub is never trusted.
// dev mode: getAuthContext is undefined; read the x-dev-user header as before.
//
// Before T-0489 this route read x-dev-user as the SOLE identity even in keycloak
// mode (FF-0328-2 bug class); it now consults getAuthContext first.
// ---------------------------------------------------------------------------

async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// resolveTenant — T-0489 [SECURITY]: derive the tenant from the actor's OWN row
// (resolveActorTenant, fail-closed) when a resolver is wired (server.ts); never a
// request-supplied tenant. When omitted (unit tests with a stub pool) the legacy
// DEV_TENANT_ID is used so dev-mode tests stay unchanged. ALL authority writes in
// this module (hire/fire/substitute/urgent-revoke) run under this tenant.
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

async function resolveTenant(
  actorSlug: string,
  resolveActorTenant: ActorTenantResolver | undefined,
): Promise<string> {
  return resolveActorTenant ? resolveActorTenant(actorSlug) : DEV_TENANT_ID;
}

// ---------------------------------------------------------------------------
// Intent-provenance audit (the "why" of I-4). Rides the SINGLE canonical sink —
// appendAuditEvent — never a parallel path. The authority writes themselves also
// emit grant.create / assignment.revoke etc. through the SAME sink; this marker
// records the intent the admin expressed (who/whom/when/why).
// ---------------------------------------------------------------------------

async function writeIntentAuditEvent(
  client: pg.PoolClient,
  args: {
    intent: "hire" | "fire" | "substitute" | "urgent-revoke";
    actor: string;
    subject: string | null;
    scope: ScopeElement | null;
    why: Record<string, unknown>;
    nowMs: number;
  },
): Promise<void> {
  const input: AuditEventInput = {
    id: randomUUID(),
    type: `intent.${args.intent}`,
    actor: args.actor,
    subject: args.subject,
    scope: args.scope as unknown,
    via: `intent:${args.intent}`,
    proposed_by: null,
    confirmed_by: args.actor,
    payload: args.why,
    occurred_at: args.nowMs,
  };
  await intentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// Shared row-mappers / helpers
// ---------------------------------------------------------------------------

function mapGrantRow(tenantId: string, g: {
  id: string; role_id: string; resource_type: string; resource_facet: unknown;
  operation: string; scope: unknown; constraint: unknown; delegable: boolean;
  granted_by: string; valid_from: string | null; valid_until: string | null; created_at: string;
}): Grant {
  return {
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
  };
}

const GRANT_COLS =
  `id, role_id, resource_type, resource_facet, operation, scope, "constraint",
   delegable, granted_by, valid_from, valid_until, created_at`;

/** Resolve a DICT_PRESETS preset by id, or 404 (T-0224 seeds the data). */
function resolvePreset(presetId: string): GrantPreset {
  const preset = DICT_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    throw new HttpError(
      404,
      "PRESET_NOT_FOUND",
      `preset '${presetId}' is not defined (preset definitions are owned by the seed; T-0224)`,
    );
  }
  return preset;
}

/**
 * Expand one preset atom (T-0135 shape) into a structural grant scope.
 * scope_own → bounded by the admitting org scope (the position's org node);
 * scope_org → the explicit org slug as an org-node ScopeElement.
 * This is the SAME client-side expansion the existing rights UI does (no preset
 * table — AC-18), lifted server-side so the intent layer never POSTs a hand-built
 * atom outside a preset (I-1).
 */
function presetAtomScope(atom: GrantPresetAtom, ownScope: ScopeElement): ScopeElement {
  if (atom.scope_own) return ownScope;
  if (atom.scope_org) {
    return normalize({
      kind: "node",
      hierarchy: "org",
      nodeId: atom.scope_org,
      nodeLevel: "department",
    } as ScopeElement);
  }
  // No scope hint on the atom → bottom (zero reach) rather than a silent widen.
  return { kind: "set", members: [] };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRightsIntentRoutes(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  registerHire(router, pool, resolveActorTenant);
  registerFire(router, pool, resolveActorTenant);
  registerSubstitute(router, pool, resolveActorTenant);
  registerUrgentRevoke(router, pool, resolveActorTenant);
  // T-0429: self-service absence ("я в отпуске") — actor declares THEIR OWN absence.
  registerSelfAbsence(router, pool, resolveActorTenant);
}

// ===========================================================================
// 3.1 hire — "add an employee → position(preset)" (ADR §3.1)
//   employee (if new) + role_assignment + ISSUE preset grant atoms.
//   Authority floor: every issued atom + the assignment is gated by
//   validateAdminDelegation against the admin's own delegable grant, and each
//   write emits an audit event in ONE withTenantTx. Critical presets are NOT
//   bypassed — they land semi-confirmed (confirmed2_by NULL) pending a second
//   approver (FF-CRITICAL-6), exactly as the kernel's dual-control gate does.
// ===========================================================================

function registerHire(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/rights/intents/hire", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveTenant(actorId, resolveActorTenant);
    const nowMs = Date.now();

    const body = (await readJsonBody(req)) as Record<string, unknown>;

    const presetId = body["preset_id"];
    if (typeof presetId !== "string") {
      throw new HttpError(400, "VALIDATION", "preset_id is required");
    }
    const roleId = body["role_id"];
    if (typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "role_id is required (the position's role)");
    }
    assertUuidShape(roleId, "role_id");

    const kindRaw = body["kind"];
    const kind: "human" | "agent" = kindRaw === "agent" ? "agent" : "human";

    // Either an existing employee_id, or (slug + display_name) to create one.
    const existingEmployeeId =
      typeof body["employee_id"] === "string" ? (body["employee_id"] as string) : null;
    const slug = typeof body["slug"] === "string" ? (body["slug"] as string) : null;
    const displayName =
      typeof body["display_name"] === "string" ? (body["display_name"] as string) : null;
    const positionId =
      typeof body["position_id"] === "string" ? (body["position_id"] as string) : null;

    if (existingEmployeeId) {
      assertUuidShape(existingEmployeeId, "employee_id");
    } else if (!slug || !displayName) {
      throw new HttpError(
        400,
        "VALIDATION",
        "either employee_id, or (slug + display_name) to create a new employee, is required",
      );
    }
    if (positionId) assertUuidShape(positionId, "position_id");

    // I-1: the preset is the ONLY source of grant atoms. 404 if T-0224 has not
    // seeded it yet — never invent a preset.
    const preset = resolvePreset(presetId);

    // The admitting org scope: the position's department node when a position is
    // given, else the admin's own org scope (the assignment ceiling).
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
    // T-0515: build the oracle from the tenant's REAL department tree (used by
    // both the assignment gate and every preset-atom grant gate below).
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    let ownScope: ScopeElement = admin.adminOrgScope;
    if (positionId) {
      ownScope = await lookupPositionOrgScope(pool, tenantId, positionId);
    }

    // T-0469 [auth] — hire mints a role_assignment with body `role_id`; if that
    // role is the genesis tenant-owner, assigning it is OWNER-ONLY. A delegable
    // mgmt grant must NOT satisfy authority for it (self-promotion path).
    const assignsOwnerRole = await isOwnerRoleScoped(pool, tenantId, roleId);

    // GATE (org axis) BEFORE any side-effect — the admin must cover the target
    // org scope to assign the role there (mirrors role-assignment gate).
    const asgGate = validateAdminDelegation(
      admin,
      { kind: "assignment", targetOrgScope: ownScope, assignsOwnerRole },
      oracle,
    );
    if (!asgGate.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", asgGate.reason);
    }

    // GATE every preset atom BEFORE writing (I-1 subset floor): each issued grant
    // must pass validateAdminDelegation against the admin's own delegable grant —
    // the same check the kernel runs on every POST /api/grants.
    const plannedGrants: Grant[] = preset.grants.map((atom) => ({
      tenantId,
      id: randomUUID(),
      roleId,
      resourceType: atom.resource_type as Grant["resourceType"],
      operation: atom.operation as Grant["operation"],
      scope: presetAtomScope(atom, ownScope) as Grant["scope"],
      constraint: atom.constraint ?? undefined,
      delegable: atom.delegable ?? true,
      grantedBy: `intent:hire:${preset.id}`,
      createdAt: nowMs,
    }));
    for (const childGrant of plannedGrants) {
      const gate = validateAdminDelegation(
        admin,
        { kind: "grant", childGrant, targetOrgScope: ownScope },
        oracle,
      );
      if (!gate.ok) {
        throw new HttpError(403, "ADMIN_GATE_REJECTED", `preset atom rejected: ${gate.reason}`);
      }
    }

    // FF-CRITICAL-6: a critical preset lands its grants SEMI-CONFIRMED
    // (confirmed2_by NULL → not active on the read-path) pending a second
    // approver. The intent layer does NOT auto-activate a critical hire.
    //
    // M2 FIX (review): gate on the FACTUAL criticality of the planned grant atoms,
    // not the author's `preset.critical` flag. Several seed presets carry an axis-a
    // atom (operation 'approve' — e.g. p-budget-approver / p-contract-approver /
    // p-role-manager) yet have NO `critical:true` flag. Under T-0397's read-path
    // dual-control gate those grants require confirmed2_by to ACTIVATE; if we kept
    // landing them on the author flag alone (confirmed2_by NULL, state 'active',
    // no second-approver flow) they would be PERMANENTLY INACTIVE — a silent
    // authority outage. combineCriticality folds the actual atoms (all four axes)
    // so an approve/transition/effect-invoke/sensitive-read preset is detected and
    // routed through the same semi-confirmed second-approver path. OR-ed with the
    // author flag so an author-marked-critical preset stays critical (fail-closed).
    const factualCriticality = combineCriticality(plannedGrants, nowMs).level;
    const critical = preset.critical === true || factualCriticality === "critical";

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // 1. Resolve / create the employee.
      let employeeId = existingEmployeeId;
      // The employee's ACTUAL kind decides the T-0619 reader grant below. For a
      // freshly-created employee it is the validated `kind`; for an existing
      // one, the request body's `kind` is not authoritative (a caller re-hiring
      // an agent could pass the default 'human'), so we read it back from the
      // row (fail-closed to non-human if the row is somehow absent).
      let effectiveKind: "human" | "agent" = kind;
      if (!employeeId) {
        employeeId = randomUUID();
        await client.query(
          `INSERT INTO choros.employee
             (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [tenantId, employeeId, positionId, kind, slug, displayName, nowMs],
        );
      } else {
        const { rows: kindRows } = await client.query<{ kind: string }>(
          `SELECT kind FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
          [tenantId, employeeId],
        );
        effectiveKind = kindRows[0]?.kind === "agent" ? "agent" : "human";
      }

      // T-0619 (ADR-T0619 §2.1): a hired HUMAN gets the baseline covering READ
      // grant via role-reader — the SAME default-open read the tenant owner
      // holds — so they can see records (incl. the ones they create). Agents are
      // NOT given role-reader here (§2.2: agent read is a separate grant
      // circuit; assistant-agent is covered by register.ts / migration 117).
      // Idempotent, inside this same hire transaction. Field-visibility is
      // UNAFFECTED — it redacts fields independently on top (§2.3).
      if (effectiveKind === "human") {
        await ensureReaderRoleAndAssignHuman(client, tenantId, employeeId, actorId, nowMs);
      }

      // 2. role_assignment (active — confirmed_by = actor).
      const raId = randomUUID();
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 NULL, NULL, 'intent:hire', $6,
                 NULL, $6, NULL, $7, $7)`,
        [tenantId, raId, employeeId, roleId, JSON.stringify(ownScope), actorId, nowMs],
      );
      await intentAuditWriter.appendAuditEvent(
        client as unknown as PgClientLike,
        encodeAssignmentAuditEvent(
          { kind: "assignment.create", actor: actorId, employeeId, roleId, orgScope: ownScope, confirmedBy: actorId },
          nowMs,
        ),
      );

      // 3. ISSUE the preset's grant atoms (I-1). confirmed2_by stays NULL for a
      //    critical preset (semi-confirmed); else it is active.
      for (const g of plannedGrants) {
        await client.query(
          `INSERT INTO choros."grant"
             (tenant_id, id, role_id, resource_type, resource_facet,
              operation, scope, "constraint", delegable, granted_by,
              valid_from, valid_until, created_at,
              proposed_by, confirmed_by, confirmed2_by)
           VALUES ($1, $2, $3, $4, NULL,
                   $5, $6::jsonb, $7::jsonb, $8, $9,
                   NULL, NULL, $10,
                   $11, $12, NULL)`,
          [
            tenantId, g.id, roleId, g.resourceType,
            g.operation, JSON.stringify(g.scope),
            g.constraint != null ? JSON.stringify(g.constraint) : null,
            g.delegable, g.grantedBy, nowMs,
            critical ? actorId : null, // proposed_by set when semi-confirmed
            actorId,                   // confirmed_by = approver1
          ],
        );
        await intentAuditWriter.appendAuditEvent(
          client as unknown as PgClientLike,
          encodeGrantAuditEvent(
            {
              kind: "grant.create",
              actor: actorId,
              subjectRoleId: roleId,
              capability: { resourceType: g.resourceType, operation: g.operation },
              scope: g.scope as unknown as ScopeElement,
              confirmedBy: actorId,
              ...(critical ? { proposedBy: actorId } : {}),
            },
            nowMs,
          ),
        );
      }

      // I-4: the intent-provenance marker (why = preset + criticality).
      await writeIntentAuditEvent(client, {
        intent: "hire",
        actor: actorId,
        subject: employeeId,
        scope: ownScope,
        why: { preset_id: preset.id, role_id: roleId, grant_count: plannedGrants.length, critical },
        nowMs,
      });

      return { employeeId, raId };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        employee_id: result.employeeId,
        role_assignment_id: result.raId,
        preset_id: preset.id,
        grants_issued: plannedGrants.length,
        state: critical ? "semi-confirmed" : "active",
        ...(critical ? { second_approver_required: true } : {}),
      }),
    );
  }));
}

// ===========================================================================
// 3.2 fire — "switch off an employee" (ADR §3.2)
//   ALL of the principal's authority is removed ATOMICALLY (FF-FIRE-2: the whole
//   revoke set is ONE withTenantTx — partial fire cannot leave residual
//   authority). Active-task reassignment/interrupt is a forward LIFECYCLE action
//   recorded AFTER the revoke commits (revoke-then-reassign ordering, ADR §3.2):
//   the routing engine itself is a non-goal (ADR §9.6) — this layer fixes the
//   ordering + records the seam, it does not implement the router.
// ===========================================================================

function registerFire(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/rights/intents/fire", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveTenant(actorId, resolveActorTenant);
    const nowMs = Date.now();

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const employeeId = body["employee_id"];
    if (typeof employeeId !== "string") {
      throw new HttpError(400, "VALIDATION", "employee_id is required");
    }
    assertUuidShape(employeeId, "employee_id");

    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

    const outcome = await withTenantTx(pool, tenantId, async (client) => {
      // Load all active (in-window, confirmed) role_assignments of the principal.
      const { rows: raRows } = await client.query<{ id: string; role_id: string; org_scope: unknown }>(
        `SELECT id, role_id, org_scope
           FROM choros.role_assignment
          WHERE tenant_id = $1 AND employee_id = $2
            AND (valid_until IS NULL OR valid_until > $3)`,
        [tenantId, employeeId, nowMs],
      );

      // T-0469 [auth] — fire revokes ALL of the target's role_assignments. If ANY
      // of them is the genesis tenant-owner assignment, STRIPPING it is OWNER-ONLY
      // (mirror of the POST /api/role-assignments/:id/revoke carve-out): a non-owner
      // — including a constructor-admin holding delegable mgmt_object:* grants — must
      // not be able to fire/demote the genesis owner (owner-strip / denial-of-owner).
      // Resolve owner-ness per assignment role and inject assignsOwnerRole into the
      // SAME validateAdminDelegation gate, so the Step-0 carve-out rejects with
      // owner_assignment_owner_only BEFORE any revoke UPDATE runs (tx aborts whole).
      const ownerRoleIds = new Set<string>();
      for (const ra of raRows) {
        if (await isOwnerRoleScoped(pool, tenantId, ra.role_id)) {
          ownerRoleIds.add(ra.role_id);
        }
      }

      // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
      const oracle = await loadTenantOrgAncestry(client, tenantId);

      // GATE: the admin must cover EVERY assignment's org scope (no partial-cover
      // fire) AND may strip a tenant-owner assignment ONLY if they are the owner.
      // Rejected before any UPDATE — the whole tx aborts.
      for (const ra of raRows) {
        const gate = validateAdminDelegation(
          admin,
          {
            kind: "assignment",
            targetOrgScope: ra.org_scope as ScopeElement,
            assignsOwnerRole: ownerRoleIds.has(ra.role_id),
          },
          oracle,
        );
        if (!gate.ok) {
          throw new HttpError(403, "ADMIN_GATE_REJECTED", `assignment ${ra.id}: ${gate.reason}`);
        }
      }

      // 1. Revoke every role_assignment (UPDATE valid_until = now) + audit.
      let revokedAssignments = 0;
      for (const ra of raRows) {
        await client.query(
          `UPDATE choros.role_assignment SET valid_until = $3, updated_at = $3
            WHERE tenant_id = $1 AND id = $2 AND (valid_until IS NULL OR valid_until > $3)`,
          [tenantId, ra.id, nowMs],
        );
        await intentAuditWriter.appendAuditEvent(
          client as unknown as PgClientLike,
          encodeAssignmentAuditEvent(
            { kind: "assignment.revoke", actor: actorId, employeeId, roleId: ra.role_id, orgScope: ra.org_scope },
            nowMs,
          ),
        );
        revokedAssignments++;
      }

      // 2. Revoke grants minted DIRECTLY to the principal (Tier-2 substitution
      //    grants carry granted_by = 'substitution:<rule_id>' / 'intent:substitute:*'
      //    and live on a role the principal solely holds). We revoke any still-
      //    effective grant whose granted_by names this employee as the loan target.
      const { rows: subRows } = await client.query<{ id: string }>(
        `SELECT g.id
           FROM choros.substitution_rule sr
           JOIN choros."grant" g
             ON g.tenant_id = sr.tenant_id AND g.id = sr.ttl_grant_id
          WHERE sr.tenant_id = $1
            AND sr.substitute_employee_id = $2
            AND sr.ttl_grant_id IS NOT NULL
            AND (g.valid_until IS NULL OR g.valid_until > $3)`,
        [tenantId, employeeId, nowMs],
      );
      let revokedGrants = 0;
      for (const gr of subRows) {
        await client.query(
          `UPDATE choros."grant" SET valid_until = $3
            WHERE tenant_id = $1 AND id = $2 AND (valid_until IS NULL OR valid_until > $3)`,
          [tenantId, gr.id, nowMs],
        );
        revokedGrants++;
      }

      // I-4: intent-provenance marker.
      await writeIntentAuditEvent(client, {
        intent: "fire",
        actor: actorId,
        subject: employeeId,
        scope: null,
        why: { revoked_assignments: revokedAssignments, revoked_sole_grants: revokedGrants },
        nowMs,
      });

      return { revokedAssignments, revokedGrants };
    });

    // 3. Active-task reassignment/interrupt is a forward lifecycle action recorded
    //    AFTER the revoke commit (revoke-then-reassign ordering, ADR §3.2). The
    //    routing engine is a non-goal (§9.6); we surface the obligation as a seam
    //    so no task executes under stale authority — the caller drives reassignment.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        employee_id: employeeId,
        revoked_assignments: outcome.revokedAssignments,
        revoked_sole_grants: outcome.revokedGrants,
        // revoke committed; active tasks must now be reassigned/interrupted (router seam).
        reassign_required: true,
      }),
    );
  }));
}

// ===========================================================================
// 3.3 substitute — "let X cover Y until date" (ADR §3.3)
//   A substitution_rule (T-0035) is declared. Tier-1 (pool holder exists) mints
//   NO grant. Tier-2 (no pool holder, or force_tier2) mints a TTL'd delegation
//   grant over a SUBSET of the substituted role's grants — subset-gated at
//   WRITE-TIME by validateNarrowing (I-2). A widening Tier-2 mint is REJECTED
//   before persistence (422 SUBSTITUTION_WIDENS), never audited-after.
//   delegable=false on the mint blocks re-delegation.
// ===========================================================================

function registerSubstitute(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/rights/intents/substitute", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveTenant(actorId, resolveActorTenant);
    const nowMs = Date.now();

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const absentEmployeeId = body["absent_employee_id"];
    const substituteEmployeeId = body["substitute_employee_id"];
    const roleId = body["role_id"];
    if (typeof absentEmployeeId !== "string" || typeof substituteEmployeeId !== "string" || typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "absent_employee_id, substitute_employee_id, role_id are required");
    }
    assertUuidShape(absentEmployeeId, "absent_employee_id");
    assertUuidShape(substituteEmployeeId, "substitute_employee_id");
    assertUuidShape(roleId, "role_id");
    if (absentEmployeeId === substituteEmployeeId) {
      throw new HttpError(400, "VALIDATION", "substitute and absentee must differ");
    }

    const validUntil = typeof body["valid_until"] === "number" ? (body["valid_until"] as number) : null;
    if (validUntil === null) {
      throw new HttpError(400, "VALIDATION", "valid_until (epoch ms) is required for a substitution");
    }
    const validFrom = typeof body["valid_from"] === "number" ? (body["valid_from"] as number) : nowMs;
    const forceTier2 = body["force_tier2"] === true;

    const rawOrgScope = body["org_scope"];
    const orgScope = rawOrgScope ? (rawOrgScope as ScopeElement) : null;
    if (!orgScope) {
      throw new HttpError(400, "VALIDATION", "org_scope (ScopeElement, hierarchy:org) is required");
    }

    // T-0469 [auth] — substitution issues authority for `role_id`; standing into
    // the genesis tenant-owner role is OWNER-ONLY (a non-owner must not be able
    // to acquire owner authority via a substitution rule).
    const assignsOwnerRole = await isOwnerRoleScoped(pool, tenantId, roleId);

    // GATE: the admin must cover the substitution's org scope (it issues authority
    // for the stand-in there). Rejected before any write.
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
    // T-0515: oracle from the tenant's REAL department tree (reused by the inner
    // validateNarrowing loop below — same tenant tree within this request).
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    const gate = validateAdminDelegation(
      admin,
      { kind: "assignment", targetOrgScope: orgScope, assignsOwnerRole },
      oracle,
    );
    if (!gate.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", gate.reason);
    }

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // Determine tier: Tier-1 if a pool holder already holds the role in scope
      // (someone else with an active assignment on this role), Tier-2 otherwise.
      const { rows: poolRows } = await client.query<{ employee_id: string }>(
        `SELECT employee_id FROM choros.role_assignment
          WHERE tenant_id = $1 AND role_id = $2
            AND employee_id <> $3 AND employee_id <> $4
            AND confirmed_by IS NOT NULL
            AND (valid_until IS NULL OR valid_until > $5)
          LIMIT 1`,
        [tenantId, roleId, absentEmployeeId, substituteEmployeeId, nowMs],
      );
      const tier2 = forceTier2 || poolRows.length === 0;

      let ttlGrantId: string | null = null;

      if (tier2) {
        // Load the substituted role's effective, confirmed grants (the PARENTS).
        const { rows: parentRows } = await client.query(
          `SELECT ${GRANT_COLS} FROM choros."grant"
            WHERE tenant_id = $1 AND role_id = $2 AND confirmed_by IS NOT NULL`,
          [tenantId, roleId],
        );
        const parentGrants = (parentRows as Parameters<typeof mapGrantRow>[1][]).map((g) =>
          mapGrantRow(tenantId, g),
        );
        // eligibleForTier2 drops non-inheritable grants (T-0035 mint-site filter).
        const eligible = eligibleForTier2(
          {
            tenantId, id: randomUUID(), absentEmployeeId, substituteEmployeeId, roleId,
            orgScope, ttlGrantId: null, nonInheritableExcluded: true,
            proposedBy: null, confirmedBy: actorId, validFrom, validUntil,
            source: "intent:substitute", createdBy: actorId, createdAt: nowMs, updatedAt: nowMs,
          },
          parentGrants,
        );
        if (eligible.length === 0) {
          throw new HttpError(
            422,
            "NO_DELEGABLE_GRANT",
            "the substituted role has no inheritable, delegable grant to loan",
          );
        }

        // Mint ONE TTL'd grant per eligible parent — each subset-checked by
        // validateNarrowing (I-2). The minted CHILD is structurally identical to
        // the parent's scope/facet/constraint (the strongest non-widening choice),
        // delegable=false. A widening mint is impossible by construction; we still
        // RE-CHECK so a future broader child shape is rejected, not audited-after.
        const mintedIds: string[] = [];
        for (const parent of eligible) {
          if (!parent.delegable) continue; // a non-delegable parent cannot be loaned
          const child: Grant = {
            tenantId,
            id: randomUUID(),
            roleId,
            resourceType: parent.resourceType,
            resourceFacet: parent.resourceFacet,
            operation: parent.operation,
            scope: parent.scope,
            constraint: parent.constraint,
            delegable: false, // loaned authority is NOT re-delegable (I-2)
            grantedBy: `intent:substitute`,
            validFrom,
            validUntil,
            createdAt: nowMs,
          };
          const narrow = validateNarrowing(parent, child, oracle);
          if (!narrow.ok) {
            // A substitution that could exceed the substituted principal is a
            // security defect — reject BEFORE persistence (I-2), never audit-after.
            throw new HttpError(422, "SUBSTITUTION_WIDENS", narrow.reason);
          }
          await client.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet,
                operation, scope, "constraint", delegable, granted_by,
                valid_from, valid_until, created_at,
                proposed_by, confirmed_by, confirmed2_by)
             VALUES ($1, $2, $3, $4, $5::jsonb,
                     $6, $7::jsonb, $8::jsonb, false, $9,
                     $10, $11, $12,
                     NULL, $13, NULL)`,
            [
              tenantId, child.id, roleId, child.resourceType,
              child.resourceFacet != null ? JSON.stringify(child.resourceFacet) : null,
              child.operation, JSON.stringify(child.scope),
              child.constraint != null ? JSON.stringify(child.constraint) : null,
              child.grantedBy, validFrom, validUntil, nowMs,
              actorId,
            ],
          );
          await intentAuditWriter.appendAuditEvent(
            client as unknown as PgClientLike,
            encodeGrantAuditEvent(
              {
                kind: "grant.create",
                actor: actorId,
                subjectRoleId: roleId,
                capability: { resourceType: child.resourceType, operation: child.operation },
                scope: child.scope as unknown as ScopeElement,
                confirmedBy: actorId,
              },
              nowMs,
            ),
          );
          mintedIds.push(child.id);
        }
        if (mintedIds.length === 0) {
          throw new HttpError(
            422,
            "NO_DELEGABLE_GRANT",
            "no delegable grant on the substituted role could be loaned",
          );
        }
        // The rule records ONE representative ttl_grant_id (T-0035 schema is 1:1);
        // the remaining minted grants share the rule's window and expire together.
        ttlGrantId = mintedIds[0];
      }

      // Declare the substitution_rule (confirmed by the actor → effective).
      const ruleId = randomUUID();
      await client.query(
        `INSERT INTO choros.substitution_rule
           (tenant_id, id, absent_employee_id, substitute_employee_id, role_id, org_scope,
            ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
            valid_from, valid_until, source, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb,
                 $7, TRUE, NULL, $8,
                 $9, $10, 'intent:substitute', $8, $11, $11)`,
        [
          tenantId, ruleId, absentEmployeeId, substituteEmployeeId, roleId,
          JSON.stringify(orgScope), ttlGrantId, actorId, validFrom, validUntil, nowMs,
        ],
      );

      // I-4: intent-provenance marker (why = tier + window).
      await writeIntentAuditEvent(client, {
        intent: "substitute",
        actor: actorId,
        subject: substituteEmployeeId,
        scope: orgScope,
        why: {
          rule_id: ruleId, absentee: absentEmployeeId, role_id: roleId,
          tier: tier2 ? 2 : 1, valid_until: validUntil, ttl_grant_id: ttlGrantId,
        },
        nowMs,
      });

      return { ruleId, tier: tier2 ? 2 : 1, ttlGrantId };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        rule_id: result.ruleId,
        tier: result.tier,
        ttl_grant_id: result.ttlGrantId,
        valid_until: validUntil,
      }),
    );
  }));
}

// ===========================================================================
// 3.4 urgent-revoke — "take right X away now" (ADR §3.4)
//   The targeted grant is revoked IMMEDIATELY (UPDATE valid_until = now). Because
//   the read-path resolver gates every decision on isEffective(grant, now), the
//   capability is gone on the NEXT PDP evaluation — no cache, no propagation
//   delay. For an AGENT principal, the response signals halt_active_run=true:
//   the in-flight run must abort at the next step boundary (fail-closed). The
//   precise halt signal is the T-0220 agent-outcome seam (ADR §3.4); D-1 fixes
//   the fail-closed contract floor + surfaces the halt obligation.
// ===========================================================================

function registerUrgentRevoke(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/rights/intents/urgent-revoke", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveTenant(actorId, resolveActorTenant);
    const nowMs = Date.now();

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const grantId = body["grant_id"];
    if (typeof grantId !== "string") {
      throw new HttpError(400, "VALIDATION", "grant_id is required");
    }
    assertUuidShape(grantId, "grant_id");
    // principal_kind is an advisory hint for the agent-step-halt seam; the
    // authority removal is identical for human/agent (revoke is revoke).
    const principalKind = body["principal_kind"] === "agent" ? "agent" : "human";

    // Fetch the grant row (404 if missing/wrong tenant), then gate the admin.
    const grantRow = await withTenantTx(pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${GRANT_COLS} FROM choros."grant" WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, grantId],
      );
      if (rows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", `grant ${grantId} not found`);
      }
      return mapGrantRow(tenantId, rows[0] as Parameters<typeof mapGrantRow>[1]);
    });

    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
    // T-0515: build the oracle from the tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    const gate = validateAdminDelegation(
      admin,
      { kind: "grant", childGrant: grantRow, targetOrgScope: admin.adminOrgScope },
      oracle,
    );
    if (!gate.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", gate.reason);
    }

    await withTenantTx(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE choros."grant" SET valid_until = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, grantId, nowMs],
      );
      await intentAuditWriter.appendAuditEvent(
        client as unknown as PgClientLike,
        encodeGrantAuditEvent(
          {
            kind: "grant.revoke",
            actor: actorId,
            subjectRoleId: grantRow.roleId,
            capability: { resourceType: grantRow.resourceType, operation: grantRow.operation, resourceFacet: grantRow.resourceFacet },
            scope: grantRow.scope as unknown as ScopeElement,
          },
          nowMs,
        ),
      );
      await writeIntentAuditEvent(client, {
        intent: "urgent-revoke",
        actor: actorId,
        subject: grantRow.roleId,
        scope: grantRow.scope as unknown as ScopeElement,
        why: { grant_id: grantId, principal_kind: principalKind },
        nowMs,
      });
    });

    // The revoked grant now fails isEffective(now) → resolver returns no_grant at
    // the next PDP evaluation. For an agent, signal the in-flight run to halt.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        grant_id: grantId,
        revoked: true,
        effective_immediately: true,
        // FF-REVOKE-3: agent runs must abort at the next step boundary (fail-closed).
        halt_active_run: principalKind === "agent",
      }),
    );
  }));
}

// ---------------------------------------------------------------------------
// lookupPositionOrgScope — resolve a position's department org-node scope.
// (mirrors the agents.ts helper; kept local so the files stay disjoint.)
// ---------------------------------------------------------------------------

async function lookupPositionOrgScope(
  pool: pg.Pool,
  tenantId: string,
  positionId: string,
): Promise<ScopeElement> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ department_id: string }>(
      `SELECT department_id FROM choros.position WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, positionId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(400, "VALIDATION", `position_id ${positionId} not found`);
    }
    return normalize({
      kind: "node",
      hierarchy: "org",
      nodeId: rows[0].department_id,
      nodeLevel: "department",
    } as ScopeElement);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// isOwnerRoleScoped — T-0469 [auth]: is `roleId` the genesis tenant-owner role?
//
// The owner role is identified by `role.slug = 'tenant-owner'` (migration 026 /
// 019). The hire/substitute intents mint role authority from a body-supplied
// `role_id`; if it resolves to the owner role, the assignment delegation is
// OWNER-ONLY (closes the self-promotion path mirror of POST /api/role-assignments).
// Tenant-scoped via SET LOCAL; an unknown role ⇒ not owner (false).
// ---------------------------------------------------------------------------

async function isOwnerRoleScoped(
  pool: pg.Pool,
  tenantId: string,
  roleId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.role
        WHERE tenant_id = $1 AND id = $2 AND slug = 'tenant-owner' LIMIT 1`,
      [tenantId, roleId],
    );
    await client.query("COMMIT");
    return rows.length > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// isEffective is imported to document the read-path contract (urgent-revoke /
// substitute auto-expiry both rely on it); referenced here to keep the binding
// explicit for reviewers and avoid an unused-import lint.
void isEffective;

// ===========================================================================
// T-0429: registerSelfAbsence — "я в отпуске" self-service absence declaration.
//
// POST /api/rights/intents/self-absence
//
// Unlike the ADMIN-path POST /api/rights/intents/substitute (which lets an admin
// declare absence FOR another employee), this endpoint lets the actor declare
// THEIR OWN absence and nominate a substitute. No admin gate on the absence WINDOW
// itself — an employee is the sole authority over when they are away. BUT a
// role-holding gate IS enforced (see below): an actor can only declare absence for
// a role they themselves currently hold, so self-absence cannot be used to loan
// authority for a role the actor does not own.
//
// Body:
//   substitute_employee_id: UUID  — the employee who will cover the absent actor
//   role_id:                UUID  — the role the absence applies to
//   valid_from:             number — epoch ms (start of absence; defaults to now)
//   valid_until:            number — epoch ms (end of absence; required)
//   org_scope:              ScopeElement — org node scope of the absence
//   force_tier2:            boolean (optional) — force Tier-2 grant mint
//
// The route is structurally identical to the admin substitute path EXCEPT:
//   - absent_employee_id is derived from the authenticated actor (not from body).
//   - No admin-gate check: the actor vouches for their own absence window. A
//     separate approval flow (dual-control or manager sign-off) for the substitute
//     grant is out of scope for this self-service intent (T-0429 D-061 discipline:
//     no new authority table; Tier-2 mints still go through the same eligibleForTier2
//     subset-gate for the grant side).
//   - The substitution_rule carries confirmedBy = actorId (self-confirmed),
//     consistent with the spec: the actor IS the absent party.
//
// on_behalf_of surface: the resulting substitution_rule.absent_employee_id = actorId,
// .substitute_employee_id = substituteId. When the substitute later acts on a task,
// the audit trail records performed_by = substitute, on_behalf_of = actor (the
// absent party) via the resolveSubstitution → kind: "substitution" path.
// ===========================================================================

function registerSelfAbsence(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant?: ActorTenantResolver,
): void {
  router.register("POST", "/api/rights/intents/self-absence", withAuth(async (req, res) => {
    // The actor declares THEIR OWN absence: actorId = absent_employee_id.
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveTenant(actorId, resolveActorTenant);
    const nowMs = Date.now();

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const substituteEmployeeId = body["substitute_employee_id"];
    const roleId = body["role_id"];

    if (typeof substituteEmployeeId !== "string" || typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "substitute_employee_id and role_id are required");
    }
    assertUuidShape(substituteEmployeeId, "substitute_employee_id");
    assertUuidShape(roleId, "role_id");

    // Resolve the actor's own employee UUID (absent_employee_id = actorId).
    // The actor is identified by their slug (dev mode) or KC sub→slug (KC mode).
    // We resolve their UUID via employee.slug lookup (same pattern as hire/fire).
    //
    // T-0658 [security/системный, столп 4] — `AND deactivated_at IS NULL`
    // (fail-closed). self-absence is the ONLY authority-WRITING handler in this
    // file that does NOT route through loadAdminContext (hire/fire/substitute/
    // urgent-revoke all do, and are gated by the org.ts T-0658 fix). It resolves
    // the actor by a bespoke inline slug→employee lookup and then gates
    // role-holding by a direct role_assignment read — NEITHER checking
    // deactivation. Deactivation (PATCH /api/users, T-0583) only sets
    // employee.deactivated_at; it does NOT revoke role_assignment. So without
    // this predicate a DEACTIVATED actor with a still-live KC token could
    // declare self-absence and, on the Tier-2 branch below, MINT a delegated
    // grant into choros."grant" for an accomplice — the accomplice is a live
    // subject, so getGrantsForSubject (T-0658 resolver A) hands them that grant.
    // Resolver A cannot catch this because the exploited subject (accomplice) is
    // NOT deactivated; the deactivated party is the WRITER. Fail-closed here:
    // a deactivated actor resolves to zero rows → 404, never reaching the mint.
    // (Same privilege-escalation class T-0588 patched locally in inbox.ts.)
    let absentEmployeeId: string;
    {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await client.query("SET LOCAL search_path TO choros");
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND deactivated_at IS NULL LIMIT 1`,
          [tenantId, actorId],
        );
        await client.query("COMMIT");
        if (rows.length === 0) {
          throw new HttpError(404, "NOT_FOUND", "actor employee record not found");
        }
        absentEmployeeId = rows[0]!.id;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    if (absentEmployeeId === substituteEmployeeId) {
      throw new HttpError(400, "VALIDATION", "substitute must differ from the absent actor");
    }

    const validUntil = typeof body["valid_until"] === "number" ? (body["valid_until"] as number) : null;
    if (validUntil === null) {
      throw new HttpError(400, "VALIDATION", "valid_until (epoch ms) is required for an absence declaration");
    }
    if (validUntil <= nowMs) {
      throw new HttpError(400, "VALIDATION", "valid_until must be in the future");
    }
    const validFrom = typeof body["valid_from"] === "number" ? (body["valid_from"] as number) : nowMs;
    const forceTier2 = body["force_tier2"] === true;

    const rawOrgScope = body["org_scope"];
    const orgScope = rawOrgScope ? (rawOrgScope as ScopeElement) : null;
    if (!orgScope) {
      throw new HttpError(400, "VALIDATION", "org_scope (ScopeElement, hierarchy:org) is required");
    }

    // T-0469: deny if the targeted role is the owner role (self-absence cannot
    // issue owner-scope authority to a substitute).
    const assignsOwnerRole = await isOwnerRoleScoped(pool, tenantId, roleId);
    if (assignsOwnerRole) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "self-absence cannot cover the tenant-owner role");
    }

    // No admin-gate check for the absence WINDOW itself — an employee can declare
    // their own absence freely. BUT the actor must HOLD the role (role-holding gate
    // inside the tx below, fail-closed). The Tier-2 grant mint (if needed) is still
    // subject to eligibleForTier2 (subset-gate, I-2).
    const result = await withTenantTx(pool, tenantId, async (client) => {
      // ---------------------------------------------------------------------
      // ROLE-HOLDING GATE (T-0429 CRITICAL security fix).
      //
      // You can only declare absence for a role you yourself hold. role_id comes
      // from the request body and is NOT otherwise tied to the actor: without this
      // check, any employee could declare self-absence on a role they do not own
      // (e.g. a financial/approval role), nominate an accomplice as substitute, and
      // — on the Tier-2 path — have that role's confirmed grants minted to the
      // accomplice. The downstream narrowing/owner-block do NOT catch this (they
      // compare against the ROLE's grants, not the ACTOR's assignments).
      //
      // Fail-closed: the absent actor MUST hold a confirmed, in-window
      // role_assignment for role_id. (orgScope-level narrowing of the assignment
      // is out of scope for the assignment table, which is org-wide per role; the
      // minted grants are still org-scope-narrowed + subset-gated below.)
      // ---------------------------------------------------------------------
      const { rows: actorHoldsRows } = await client.query<{ employee_id: string }>(
        `SELECT employee_id FROM choros.role_assignment
          WHERE tenant_id = $1 AND role_id = $2
            AND employee_id = $3
            AND confirmed_by IS NOT NULL
            AND (valid_until IS NULL OR valid_until > $4)
          LIMIT 1`,
        [tenantId, roleId, absentEmployeeId, nowMs],
      );
      if (actorHoldsRows.length === 0) {
        throw new HttpError(
          403,
          "ADMIN_GATE_REJECTED",
          "you can only declare absence for a role you currently hold",
        );
      }

      // Determine tier: Tier-1 if another pool holder holds the role in scope.
      const { rows: poolRows } = await client.query<{ employee_id: string }>(
        `SELECT employee_id FROM choros.role_assignment
          WHERE tenant_id = $1 AND role_id = $2
            AND employee_id <> $3 AND employee_id <> $4
            AND confirmed_by IS NOT NULL
            AND (valid_until IS NULL OR valid_until > $5)
          LIMIT 1`,
        [tenantId, roleId, absentEmployeeId, substituteEmployeeId, nowMs],
      );
      const tier2 = forceTier2 || poolRows.length === 0;

      let ttlGrantId: string | null = null;

      if (tier2) {
        // Tier-2: mint a TTL'd delegation grant to the substitute (subset-gated).
        const { rows: parentRows } = await client.query(
          `SELECT ${GRANT_COLS} FROM choros."grant"
            WHERE tenant_id = $1 AND role_id = $2 AND confirmed_by IS NOT NULL`,
          [tenantId, roleId],
        );
        const parentGrants = (parentRows as Parameters<typeof mapGrantRow>[1][]).map((g) =>
          mapGrantRow(tenantId, g),
        );
        const eligible = eligibleForTier2(
          {
            tenantId, id: randomUUID(), absentEmployeeId, substituteEmployeeId, roleId,
            orgScope, ttlGrantId: null, nonInheritableExcluded: true,
            proposedBy: null, confirmedBy: actorId, validFrom, validUntil,
            source: "intent:self-absence", createdBy: actorId, createdAt: nowMs, updatedAt: nowMs,
          },
          parentGrants,
        );
        if (eligible.length === 0) {
          throw new HttpError(
            422,
            "NO_DELEGABLE_GRANT",
            "the absence role has no inheritable, delegable grant to loan to the substitute",
          );
        }

        const mintedIds: string[] = [];
        for (const parent of eligible) {
          if (!parent.delegable) continue;
          const narrowed: Grant = {
            tenantId,
            id: randomUUID(),
            roleId,
            resourceType: parent.resourceType,
            resourceFacet: parent.resourceFacet,
            operation: parent.operation,
            scope: orgScope,
            constraint: parent.constraint,
            delegable: false, // loaned authority is NOT re-delegable (I-2)
            grantedBy: `intent:self-absence`,
            validFrom,
            validUntil,
            createdAt: nowMs,
          };
          const narrowCheck = validateNarrowing(parent, narrowed, {
            isDescendantOrSelf: (_h, d, a) => d === a, // flat oracle for self-absence
          });
          if (!narrowCheck.ok) {
            throw new HttpError(422, "SUBSTITUTION_WIDENS", narrowCheck.reason);
          }
          await client.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet,
                operation, scope, "constraint", delegable, granted_by,
                valid_from, valid_until, created_at,
                proposed_by, confirmed_by, confirmed2_by)
             VALUES ($1, $2, $3, $4, $5::jsonb,
                     $6, $7::jsonb, $8::jsonb, false, $9,
                     $10, $11, $12,
                     NULL, $13, NULL)`,
            [
              tenantId, narrowed.id, roleId, narrowed.resourceType,
              narrowed.resourceFacet != null ? JSON.stringify(narrowed.resourceFacet) : null,
              narrowed.operation, JSON.stringify(narrowed.scope),
              narrowed.constraint != null ? JSON.stringify(narrowed.constraint) : null,
              narrowed.grantedBy, validFrom, validUntil, nowMs,
              actorId,
            ],
          );
          mintedIds.push(narrowed.id);
        }
        if (mintedIds.length > 0) {
          ttlGrantId = mintedIds[0]!;
        }
      }

      // Insert the substitution_rule row (Tier-1 or Tier-2).
      // confirmedBy = actorId (self-confirmed: the absent party vouches for their own window).
      const ruleId = randomUUID();
      await client.query(
        `INSERT INTO choros.substitution_rule
          (id, tenant_id, absent_employee_id, substitute_employee_id, role_id,
           org_scope, ttl_grant_id, non_inheritable_excluded,
           proposed_by, confirmed_by, valid_from, valid_until,
           source, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          ruleId, tenantId, absentEmployeeId, substituteEmployeeId, roleId,
          JSON.stringify(orgScope), ttlGrantId, true,
          null, actorId, validFrom, validUntil,
          "intent:self-absence", actorId, nowMs,
        ],
      );

      return { ruleId, tier: tier2 ? "tier2" : "tier1", ttlGrantId };
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      rule_id: result.ruleId,
      absent_employee_id: absentEmployeeId,
      substitute_employee_id: substituteEmployeeId,
      role_id: roleId,
      valid_from: body["valid_from"] ?? nowMs,
      valid_until: validUntil,
      tier: result.tier,
      ttl_grant_id: result.ttlGrantId,
      // on_behalf_of provenance surface (T-0429):
      //   When the substitute later acts on a task routed via this rule,
      //   performed_by = substitute_employee_id, on_behalf_of = absent_employee_id.
      //   The resolver emits kind: "substitution" { absentSlug, substituteSlug }
      //   which the inbox/audit layer maps to these two fields.
      on_behalf_of_hint: "substitute acts on behalf of absent_employee_id",
    }));
  }));
}
