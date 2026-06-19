/**
 * src/http/agents.ts — T-0042 (E5.2): Agent hire route.
 *
 * Registers POST /api/agents/hire.
 *
 * Composition order (ADR §1, step-by-step):
 *   1. extractActor(req)  — x-dev-user under CHOROS_AUTH_MODE=dev (NF-3 / AC-15)
 *   2. loadAdminContext + validateAdminDelegation({kind:"assignment"}, targetOrgScope)
 *      — GATE BEFORE ANY SIDE-EFFECT (FF-HIRE-1 / FR-1 / AC-1/3)
 *   3. buildAgentHirePlan(body)  — derive kc_client_id (pure)
 *   4. kcPort.createServiceAccountClient(spec)  — Keycloak FIRST (NF-4 / ADR §4)
 *   5. withTenantTx:
 *        insertAgentRows(tx, plan)    — DB INSERT employee + agent_card
 *        appendAuditEvent(tx, audit)  — hire audit row (FR-6 / AC-11)
 *      On DB failure → best-effort kcPort.deleteClient (NF-4 / AC-7)
 *   6. 201 {employee_id, kc_client_id}
 *
 * Sister task boundaries:
 *   T-0060: JWT validation — NOT touched here (only x-dev-user / dev-auth seam).
 *   T-0024: invoke-grants — NOT touched here (hire ends at employee+agent_card+KC).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadAdminContext } from "../db/org.js";
import { validateAdminDelegation } from "../core/scoped-admin.js";
import {
  buildAgentHirePlan,
  encodeAgentHireAuditEvent,
  type KeycloakAdminPort,
  type AgentHireAuditEvent,
} from "../core/agent-hire.js";
import { insertAgentRows, AgentConflictError } from "../db/agent-provision.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, withAuth } from "./auth.js";
import type { ScopeElement } from "../core/grant-lattice.js";
import { validateSecretHandleShape } from "../core/secret-handle-validator.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";

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

import { SEED_ORACLE } from "./seed-ancestry.js";

// ---------------------------------------------------------------------------
// withTenantTx helper (write-path, mirrors grants.ts)
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
// Canonical audit writer (singleton, mirrors grants.ts)
// ---------------------------------------------------------------------------

const agentAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// extractActor — dev-auth stub (NF-3 / AC-15)
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// lookupPositionOrgNode — resolve the org node for a position_id
// Day-1: direct DB lookup inside a tenant-scoped read (no full tree traversal needed).
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
    const { rows } = await client.query<{ department_id: string; id: string }>(
      `SELECT id, department_id FROM choros.position WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, positionId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(400, "VALIDATION", `position_id ${positionId} not found`);
    }
    // Return a scope element keyed on the department's ID (the org node).
    // day-1: we use the department_id as the org node for the scope check.
    return {
      kind: "node",
      hierarchy: "org",
      nodeId: rows[0].department_id,
      nodeLevel: "department",
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register POST /api/agents/hire (T-0042 — additive, no existing routes modified).
 *
 * The kcPort parameter is the KeycloakAdminPort — injected so tests can substitute
 * an InMemoryKeycloakAdminPort without a live Keycloak (NF-7 / AC-16 / FF-HIRE-6).
 */
export function registerAgentRoutes(
  router: Router,
  pool: pg.Pool,
  kcPort: KeycloakAdminPort,
): void {

  // ---- POST /api/agents/hire ----------------------------------------------
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/agents/hire", withAuth(async (req, res) => {
    const actorId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    // Validate required fields
    const positionId = b["position_id"];
    if (typeof positionId !== "string") {
      throw new HttpError(400, "VALIDATION", "position_id is required");
    }
    assertUuidShape(positionId, "position_id");

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }

    const displayName = b["display_name"];
    if (typeof displayName !== "string" || displayName.trim() === "") {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }

    // Optional Stage-2 fields
    const llmEndpoint = typeof b["llm_endpoint"] === "string" ? b["llm_endpoint"] : null;
    const llmModel = typeof b["llm_model"] === "string" ? b["llm_model"] : null;
    const llmSecretHandle = typeof b["llm_secret_handle"] === "string" ? b["llm_secret_handle"] : null;
    const autonomyThreshold = typeof b["autonomy_threshold"] === "number" ? b["autonomy_threshold"] : null;

    // ── C-1: validate llm_secret_handle shape BEFORE any side-effect (RL-3 / FF-25-8) ──
    // NF-1: verdict.reason is a CODE, never the handle value itself.
    if (llmSecretHandle !== null) {
      const verdict = validateSecretHandleShape(llmSecretHandle);
      if (!verdict.ok) {
        throw new HttpError(400, "INVALID_HANDLE", verdict.reason);
      }
    }

    // ── Step 2: GATE — validateAdminDelegation BEFORE any side-effect (FF-HIRE-1) ──
    // Resolve the org scope for the target position_id (the admin's grant must admit it).
    const targetOrgScope = await lookupPositionOrgScope(pool, tenantId, positionId);

    // Load admin context (DB read — no side-effect).
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

    // Gate: {kind:"assignment"} — the org-axis is the whole check for agent hire
    // (analogous to role-assignment gate in grants.ts; the position's org node is
    // the target scope the admin's grant must cover). Rejected before KC call or DB write.
    const gateResult = validateAdminDelegation(
      admin,
      { kind: "assignment", targetOrgScope },
      SEED_ORACLE,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "no_mgmt_grant", gateResult.reason);
    }

    // ── Step 3: Build the hire plan (pure) ───────────────────────────────────
    const plan = buildAgentHirePlan({
      tenantId,
      positionId,
      slug,
      displayName,
      llmEndpoint,
      llmModel,
      llmSecretHandle,
      autonomyThreshold,
      nowMs,
    });

    // ── Step 4: Keycloak FIRST (NF-4 / ADR §4) ───────────────────────────────
    // Create the service account BEFORE the DB transaction.
    // If this fails → no DB write, no orphan (AC-6).
    let kcResult: { clientId: string };
    try {
      kcResult = await kcPort.createServiceAccountClient(plan.kcSpec);
    } catch (kcErr) {
      throw new HttpError(
        503,
        "keycloak_failed",
        kcErr instanceof Error ? kcErr.message : "Keycloak service account creation failed",
      );
    }

    // ── Step 5: DB transaction — insertAgentRows + appendAuditEvent ───────────
    // If the tx fails after KC succeeded → best-effort deleteClient (NF-4 / AC-7).
    try {
      await withTenantTx(pool, tenantId, async (client) => {
        // INSERT employee + agent_card (UNIQUE violation → AgentConflictError → 409)
        await insertAgentRows(client as unknown as PgClientLike, plan);

        // Hire audit row (FR-6 / AC-11) — same tx (audit failure rolls back rows)
        const auditEvt: AgentHireAuditEvent = {
          actor: actorId,
          subject: plan.employee.id,
          capability: { resourceType: "mgmt_object:agent", operation: "create" },
          scope: targetOrgScope,
        };
        const auditInput = encodeAgentHireAuditEvent(auditEvt, nowMs, randomUUID());
        await agentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, auditInput);

        // C-1: when llmSecretHandle is non-NULL, emit the canonical custody audit
        // event set_llm_secret_handle in the SAME withTenantTx — no handle value in
        // any field (NF-1 / ADR §13.4). Omitted when llmSecretHandle is NULL.
        if (llmSecretHandle !== null) {
          const custodyAuditInput: AuditEventInput = {
            id: randomUUID(),
            type: "set_llm_secret_handle",
            actor: actorId,
            subject: plan.employee.id,
            scope: null,
            via: "secret-handle",
            proposed_by: null,
            confirmed_by: null,
            payload: { agentEmployeeId: plan.employee.id },
            occurred_at: nowMs,
          };
          await agentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, custodyAuditInput);
        }
      });
    } catch (dbErr) {
      // Best-effort orphan cleanup — attempt to delete the KC client (NF-4 / AC-7).
      // We do NOT await failure of delete to avoid masking the DB error.
      void kcPort.deleteClient(kcResult.clientId).catch(() => {
        // Audit the orphan-cleanup failure if delete also fails — best-effort only.
        // In production this would emit a structured log/alert; for now swallow.
      });

      // Surface typed 409 for conflict, 500 for other DB errors.
      if (dbErr instanceof AgentConflictError) {
        throw new HttpError(409, "client_id_conflict", dbErr.message);
      }
      throw new HttpError(
        500,
        "db_failed",
        dbErr instanceof Error ? dbErr.message : "DB commit failed after Keycloak create",
      );
    }

    // ── Step 6: 201 response ─────────────────────────────────────────────────
    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        employee_id: plan.employee.id,
        kc_client_id: kcResult.clientId,
      }),
    );
  }));
}
