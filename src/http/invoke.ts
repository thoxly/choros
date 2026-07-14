/**
 * src/http/invoke.ts
 *
 * T-0024 E5.4: Invoke-grant HTTP routes — request vs command split.
 *
 * Routes:
 *   POST /api/invoke/request  — checks invoke-grant, inserts invoke_proposal
 *                               (status='proposed'), emits "invoke.request" audit.
 *   POST /api/invoke/command  — checks invoke-grant, emits "invoke.command" audit,
 *                               returns 202 { invocation_id } (dispatch = stub day-1).
 *
 * DESIGN INVARIANTS:
 *  - Caller identity from X-Dev-User header (NF-6; same dev convention as grants.ts).
 *  - Grant check uses coversInvoke() which composes T-0018 primitives
 *    (isNarrowerOrEqual + isEffective) — no second authority subsystem (NF-2/FF-IG-5).
 *  - Audit goes through encodeInvokeAuditEvent → appendAuditEvent canonical seam only
 *    (NF-3/FF-IG-6).
 *  - Fail-closed: 403 FORBIDDEN if no covering invoke-grant; no row inserted, no audit
 *    (NF-4/FF-IG-7).
 *  - INSERT + audit in ONE withTenantTx (atomic, mirrors grants.ts).
 *  - No cross-table FK: caller_id/target_id are application-layer validated (T-0017 lesson).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import {
  type Grant,
  type ScopeElement,
  type AncestryOracle,
  isNarrowerOrEqual,
  isEffective,
} from "../core/grant-lattice.js";
import {
  encodeInvokeAuditEvent,
  type InvokeAuditEvent,
  type AuditEventInput,
} from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, getAuthMode, withAuth } from "./auth.js";
import {
  resolveActorSlugFromAuth,
  resolveAgentSlugFromAuth,
  resolveActorTenant,
} from "../db/org.js";
import { SEED_ORACLE } from "./seed-ancestry.js";
// SEED_ORACLE re-exported for unit tests (invoke-grant.test.ts) — handlers below
// build the oracle from the tenant's REAL department tree (T-0515).
export { SEED_ORACLE };
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import { getGrantsForSubject } from "../db/grants-dao.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors grants.ts pattern)
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

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
// extractCallerId — mode-aware caller identity (T-0418 [SECURITY] P0).
//
// invoke is an AGENT-RUNTIME surface whose authorization is a real fail-closed
// invoke-grant check keyed on `callerId` (== role_assignment.employee_id). Before
// T-0418 the caller was read from the UNAUTHENTICATED x-dev-user header even in
// keycloak mode — so an attacker could impersonate any caller and ride that
// actor's invoke-grants. The routes are now withAuth-wrapped (the Bearer JWT is
// validated and getAuthContext populated BEFORE this runs), and the caller is
// derived from the VALIDATED token — never from a header.
//
// Mirrors binding.ts::extractActorSlug (the canonical mode-aware pattern):
//   - keycloak: getAuthContext is populated → resolve the slug from the token
//     (sub/preferred_username → employee.slug). null → 401 fail-closed; we never
//     fall through to x-dev-user when an identity was authenticated.
//   - dev: getAuthContext is undefined (withAuth is a no-op) → x-dev-user, the
//     existing dev convention. Dev tests + the SPA dev path are unchanged.
//
// T-0424 [SECURITY] P0 — DISJOINT agent path: invoke is an AGENT-RUNTIME surface,
// so its callers may be agents (Keycloak service-accounts presenting
// actor_type=agent), not just humans. The keycloak branch selects the resolution
// path on the VALIDATED `actor_type` claim (never a header/body):
//   - actor_type === 'agent' → resolveAgentSlugFromAuth (service-account-<clientId>
//     → agent_card.kc_client_id → kind='agent' employee.slug). This is the SEPARATE
//     bridge; it can ONLY ever return an agent slug.
//   - else (human) → resolveActorSlugFromAuth, UNTOUCHED, with its kind='human'
//     T-0372 anti-impersonation guard intact.
// The two paths query disjoint kind partitions and each fails closed (null → 401);
// an agent token cannot ride the human path or vice-versa (ADR §2-3).
// ---------------------------------------------------------------------------

async function extractCallerId(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    // keycloak path: the identity is the validated token, NOT a request header.
    // Branch on the validated actor_type claim → disjoint agent vs human bridge.
    const slug =
      ctx.actorType === "agent"
        ? await resolveAgentSlugFromAuth(pool, ctx)
        : await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  // dev path: x-dev-user convention.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// resolveInvokeTenant — T-0424 [SECURITY] §4: derive the invoke tenant from the
// resolved caller, replacing the DEV_TENANT_ID pin in keycloak mode.
//
// The DEV_TENANT_ID pin was acceptable while the caller was also dev-pinned, but
// with a real (agent or human) identity it is a cross-tenant correctness gap: a
// multi-tenant caller's token would still operate against DEV_TENANT_ID's cards/
// grants. In keycloak mode the tenant is derived from the caller's OWN employee
// row (resolveActorTenant), exactly as the human surfaces already do — so invoke
// becomes single-tenant per call, keyed off the caller's own tenant, and the
// target agent is then validated WITHIN that tenant under its RLS GUC. Dev mode
// keeps the single-silo pin (getAuthContext is undefined / no token).
// ---------------------------------------------------------------------------

async function resolveInvokeTenant(
  pool: pg.Pool,
  callerSlug: string,
): Promise<string> {
  return getAuthMode() === "keycloak"
    ? resolveActorTenant(pool, callerSlug)
    : DEV_TENANT_ID;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

const invokeAuditWriter = makePgAuditWriter();

export async function writeInvokeAuditEvent(
  client: pg.PoolClient,
  _tenantId: string,
  evt: InvokeAuditEvent,
  nowMs: number,
): Promise<void> {
  const input: AuditEventInput = encodeInvokeAuditEvent(evt, nowMs);
  await invokeAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// coversInvoke — the covering predicate for an invoke-grant.
//
// A grant covers the invocation iff ALL of:
//   1. operation === 'invoke'
//   2. isEffective(grant, nowMs) — within validity window (T-0018)
//   3. resource_facet.agent_role_id === targetRoleId — role match
//   4. isNarrowerOrEqual(targetOrgScope, grant.scope, oracle) — scope covers target
//
// This composes the exported T-0018 primitives (isNarrowerOrEqual + isEffective).
// It is the ONLY grant-decision path; no second authority subsystem.
// ---------------------------------------------------------------------------

export function coversInvoke(
  grant: Grant,
  targetRoleId: string,
  targetOrgScope: ScopeElement,
  nowMs: number,
  oracle: AncestryOracle,
): boolean {
  if (grant.operation !== "invoke") return false;
  if (!isEffective(grant, nowMs)) return false;

  // resource_facet must carry agent_role_id matching the target's assigned role
  const facet = grant.resourceFacet as Record<string, unknown> | undefined;
  if (!facet || facet["agent_role_id"] !== targetRoleId) return false;

  // Grant scope must cover the target's org position
  const grantScope = grant.scope;
  if (grantScope.kind === "freeform") return false;
  return isNarrowerOrEqual(targetOrgScope, grantScope as ScopeElement, oracle);
}

// ---------------------------------------------------------------------------
// DB helpers — load agent_card and role_assignment
// ---------------------------------------------------------------------------

interface AgentCardRow {
  employee_id: string;
}

interface RoleAssignmentRow {
  role_id: string;
  org_scope: unknown;
}

async function loadAgentCard(
  client: pg.PoolClient,
  tenantId: string,
  targetAgentId: string,
): Promise<AgentCardRow | null> {
  const { rows } = await client.query<AgentCardRow>(
    `SELECT employee_id FROM choros.agent_card
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, targetAgentId],
  );
  return rows[0] ?? null;
}

async function loadActiveRoleAssignment(
  client: pg.PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<RoleAssignmentRow | null> {
  const { rows } = await client.query<RoleAssignmentRow>(
    `SELECT role_id, org_scope FROM choros.role_assignment
      WHERE tenant_id = $1 AND employee_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, employeeId],
  );
  return rows[0] ?? null;
}

// T-0610 [security-debt, столп4]: single-resolver fix (F-1, T-0605 review).
//
// Prior to this fix, this function ran its OWN inline SQL (JOIN role_assignment
// + grant, filtered ONLY on operation='invoke') — a second, weaker authority
// path parallel to getGrantsForSubject (grants-dao.ts), the ONE resolver every
// other PDP consumer in the codebase uses (records.ts, org.ts, inbox.ts,
// capability-grants-dao.ts, sandbox-gate-dao.ts, registry-digest-dao.ts,
// role-grant-dao.ts). The inline query had NO assignment-active predicate
// (no confirmed_by, no window, no T-0605 canonical confirmed2_by/proposed_by
// gate) and NO grant-active predicate (no confirmed_by, no window, no T-0397
// criticalGrantPredicate + confirmed2_by dual-control gate) — so an
// unconfirmed/expired role assignment, or a semi-confirmed (one-approver)
// invoke-grant (axis-b critical by construction: resource_type=
// 'effect_resource' AND operation='invoke'), was silently treated as
// PDP-active. Dual-control was bypassed entirely on the one surface whose
// purpose is gating an external agent effect.
//
// FIX: delegate to getGrantsForSubject (the canonical resolver — already
// applies the T-0605 assignment-active predicate + T-0397 grant dual-control
// gate) and filter its result to operation='invoke' in TS — the exact pattern
// capability-grants-dao.ts already uses (getGrantsForSubject → predicate
// filter). No new SQL, no re-derived predicate, no migration (ADR-T0610 §2).
async function loadCallerInvokeGrants(
  pool: pg.Pool,
  tenantId: string,
  callerId: string,
  nowMs: number,
): Promise<Grant[]> {
  const grants = await getGrantsForSubject(pool, tenantId, callerId, nowMs);
  return grants.filter((g) => g.operation === "invoke");
}

// ---------------------------------------------------------------------------
// validateInvokeBody — parse and validate request body
// ---------------------------------------------------------------------------

interface InvokeBody {
  target_agent_id: string;
  goal: string;
  context?: unknown;
}

function validateInvokeBody(body: unknown): InvokeBody {
  if (body === null || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const targetAgentId = b["target_agent_id"];
  if (typeof targetAgentId !== "string" || !UUID_RE.test(targetAgentId)) {
    throw new HttpError(400, "VALIDATION", "target_agent_id must be a valid UUID");
  }

  const goal = b["goal"];
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "goal must be a non-empty string");
  }

  return {
    target_agent_id: targetAgentId,
    goal: goal.trim(),
    context: b["context"],
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerInvokeRoutes(router: Router, pool: pg.Pool): void {

  // ---------- POST /api/invoke/request (FR-3 / AC-1/2/5/7/8/9/10/11) -------
  // T-0418 [SECURITY] P0: withAuth-wrapped — keycloak mode REQUIRES a valid Bearer
  // (401 otherwise; x-dev-user no longer bypasses); dev mode is a no-op pass-through.
  router.register("POST", "/api/invoke/request", withAuth(async (req, res) => {
    const callerId = await extractCallerId(req, pool);
    const tenantId = await resolveInvokeTenant(pool, callerId);
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const body = validateInvokeBody(rawBody);

    const { target_agent_id: targetAgentId, goal, context } = body;
    assertUuidShape(targetAgentId, "target_agent_id");

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // FR-8: validate target is a provisioned agent
      const agentCard = await loadAgentCard(client, tenantId, targetAgentId);
      if (!agentCard) {
        throw new HttpError(400, "VALIDATION", "target_agent_id is not a provisioned agent");
      }

      // Load target's active role assignment
      const roleAssignment = await loadActiveRoleAssignment(client, tenantId, targetAgentId);
      if (!roleAssignment) {
        throw new HttpError(400, "VALIDATION", "target agent has no active role assignment");
      }

      const targetRoleId = roleAssignment.role_id;
      const targetOrgScope = roleAssignment.org_scope as ScopeElement;

      // Load caller's invoke-grants (NF-4: fail-closed). T-0610: resolved via
      // the SAME getGrantsForSubject DAO the rest of the PDP uses (own
      // read-scoped tx on `pool`, independent of this write tx's `client` —
      // mirrors records.ts's resolveFieldVisibility/resolveReadVisibility).
      const grants = await loadCallerInvokeGrants(pool, tenantId, callerId, nowMs);

      // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
      const oracle = await loadTenantOrgAncestry(client, tenantId);

      // Find a covering grant
      const coveringGrant = grants.find((g) =>
        coversInvoke(g, targetRoleId, targetOrgScope, nowMs, oracle),
      );

      // NF-4: fail-closed — no row, no audit if no grant
      if (!coveringGrant) {
        throw new HttpError(403, "FORBIDDEN", "no covering invoke-grant for this agent");
      }

      // Insert invoke_proposal (status='proposed')
      const proposalId = randomUUID();
      await client.query(
        `INSERT INTO choros.invoke_proposal
           (tenant_id, id, caller_id, target_id, goal, context, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7)`,
        [tenantId, proposalId, callerId, targetAgentId, goal, context ?? null, nowMs],
      );

      // Audit "invoke.request" (AC-5)
      const invokeEvt: InvokeAuditEvent = {
        kind: "invoke.request",
        actor: callerId,
        targetAgentId,
        agentRoleId: targetRoleId,
        orgScope: targetOrgScope,
        goal,
      };
      await writeInvokeAuditEvent(client, tenantId, invokeEvt, nowMs);

      return { id: proposalId };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  }));

  // ---------- POST /api/invoke/command (FR-4 / AC-3/4/6/7) -----------------
  // T-0418 [SECURITY] P0: withAuth-wrapped — caller derived from validated token.
  router.register("POST", "/api/invoke/command", withAuth(async (req, res) => {
    const callerId = await extractCallerId(req, pool);
    const tenantId = await resolveInvokeTenant(pool, callerId);
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const body = validateInvokeBody(rawBody);

    const { target_agent_id: targetAgentId, goal } = body;
    assertUuidShape(targetAgentId, "target_agent_id");

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // FR-8: validate target is a provisioned agent
      const agentCard = await loadAgentCard(client, tenantId, targetAgentId);
      if (!agentCard) {
        throw new HttpError(400, "VALIDATION", "target_agent_id is not a provisioned agent");
      }

      // Load target's active role assignment
      const roleAssignment = await loadActiveRoleAssignment(client, tenantId, targetAgentId);
      if (!roleAssignment) {
        throw new HttpError(400, "VALIDATION", "target agent has no active role assignment");
      }

      const targetRoleId = roleAssignment.role_id;
      const targetOrgScope = roleAssignment.org_scope as ScopeElement;

      // Load caller's invoke-grants. T-0610: same getGrantsForSubject DAO as
      // the rest of the PDP (own read-scoped tx on `pool`).
      const grants = await loadCallerInvokeGrants(pool, tenantId, callerId, nowMs);

      // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
      const oracle = await loadTenantOrgAncestry(client, tenantId);

      // Find a covering grant
      const coveringGrant = grants.find((g) =>
        coversInvoke(g, targetRoleId, targetOrgScope, nowMs, oracle),
      );

      // Fail-closed
      if (!coveringGrant) {
        throw new HttpError(403, "FORBIDDEN", "no covering invoke-grant for this agent");
      }

      // Day-1: dispatch is a no-op stub (Stage-2 connects real dispatch)
      const invocationId = randomUUID();

      // Audit "invoke.command" (AC-6)
      const invokeEvt: InvokeAuditEvent = {
        kind: "invoke.command",
        actor: callerId,
        targetAgentId,
        agentRoleId: targetRoleId,
        orgScope: targetOrgScope,
        goal,
      };
      await writeInvokeAuditEvent(client, tenantId, invokeEvt, nowMs);

      return { invocation_id: invocationId };
    });

    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  }));
}
