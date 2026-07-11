/**
 * src/http/artifacts.ts — T-0087 E12.6: artifact tier-promote endpoint.
 *
 * Registers:
 *   POST /api/artifacts/:id/promote
 *
 * Contract (ADR §4.3 / §4.5):
 *   - actor_type comes from the AUTHENTICATED claim (getAuthContext in keycloak mode,
 *     or employee.type in dev mode) — NEVER from the request body (T-0044 §9).
 *   - agent actor → 403 FORBIDDEN_AGENT_SELF_PROMOTE (AC-7).
 *   - artifact already published → 409 NOT_IN_DRAFT.
 *   - artifact not found → 404 NOT_FOUND.
 *   - missing DATABASE_URL → 503 DB_UNAVAILABLE (honest degrade).
 *   - success: flips tier=published + appends artifact.promoted audit row atomically
 *     (NF-2 / NF-3 / AC-4 / AC-5), sets SET LOCAL choros.promoting='1' to unlock
 *     the DB trigger (ADR §4.2b).
 *
 * AUTHORITY CHECK (ADR §4.5 / T-0513 security fix): gates on
 *   grant(resource_type='mgmt_object:tier_promote', operation='transition').
 *   Injectable via ArtifactAuthzDeps (same pattern as ReportPageAuthzDeps / T-0171).
 *   Default: loadAdminContext + genesis-owner short-circuit. Fail-closed: 403
 *   NO_PROMOTE_GRANT when the actor lacks authority.
 *
 * SUPPORTED ARTIFACT TABLES (ADR §4.1 tier-bearing config class):
 *   application, registry_def, grant, agent_instruction
 *   (record is the data class — not promotable via this endpoint).
 *   agent_instruction is the T-0123 competence layer: it reuses this promote path
 *   verbatim (NF-1) — promoteTier/decidePromote/the trigger are NOT modified, only
 *   the CONFIG_TABLES registry is extended additively.
 *
 * Promote does NOT touch choros.record or any data rows — config-only (FR-3 / AC-3).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { findEmployee } from "./org.js";
import { resolveActorSlugFromAuth, loadAdminContext } from "../db/org.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { decidePromote } from "../core/env-tier.js";
// T-0645 [SECURITY]: agent-instruction promotion must require the SAME authority
// as saving its draft — mgmt_object:agent/update over the OWNING agent. Reuse the
// single shared predicate + the tenant ancestry oracle (no bespoke 3rd check).
import { holdsAgentMgmtUpdate } from "../core/agent-mgmt-authority.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import type { ScopeElement } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// Startup-time validation of DEV_TENANT_ID (R-4): emit a clear error if the env
// var is set to a non-UUID value so operators see the root cause immediately,
// rather than a generic 400 VALIDATION on the first request.
const _rawDevTenantId = process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
if (!UUID_RE.test(_rawDevTenantId)) {
  throw new Error(
    `[artifacts] DEV_TENANT_ID env var is not a valid UUID: "${_rawDevTenantId}". ` +
    `Fix the env var or unset it to use the built-in default.`,
  );
}
const DEV_TENANT_ID = _rawDevTenantId;

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as db/org.ts)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new HttpError(503, "DB_UNAVAILABLE", "DATABASE_URL not set");
    }
    _pool = new pg.Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors grants.ts / agents.ts pattern
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
// ArtifactAuthzDeps — injectable PDP gate (T-0513 security fix / T-0021 seam)
//
// Checks mgmt_object:tier_promote with operation 'transition' (ADR §4.5).
// Genesis-owner short-circuit mirrors report-pages.ts / T-0121d pattern.
//
// Injectable via ArtifactAuthzDeps so tests can stub the check without a DB.
// ---------------------------------------------------------------------------

export interface ArtifactAuthzDeps {
  /**
   * Check whether `actorId` may promote the artifact identified by `ctx`.
   *
   * For every config table EXCEPT `agent_instruction`: the generic
   * `mgmt_object:tier_promote` / `transition` authority (grant / registry_def /
   * application — shared promotion capability, unchanged).
   *
   * For `agent_instruction` (T-0645 [SECURITY]): the SCOPED
   * `mgmt_object:agent/update` authority over the OWNING agent — the SAME right
   * `saveDraft` requires. This closes the T-0637 asymmetry where publishing an
   * agent instruction (the live LLM system prompt) needed only the generic,
   * agent-unbound `tier_promote` grant that grant/registry/app publishing shares.
   *
   * Returns `{ ok: true }` or `{ ok: false; reason: string }`.
   */
  checkTierPromoteGrant: (
    pool: pg.Pool,
    tenantId: string,
    actorId: string,
    nowMs: number,
    ctx: { artifactTable: string; artifactId: string },
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Resolve the org scope of the agent that OWNS the given agent_instruction row.
 *
 * Mirrors agents.ts::loadAgentOrgScope (employee → position → department). A row
 * that is absent, or whose owning agent has no department, maps to the tenant-root
 * org node — so only a root-covering delegation (or genesis-owner) admits it, and
 * a non-existent instruction id can never be promoted by a merely department-scoped
 * holder (fail-closed; promoteTier then returns the honest 404 for the missing row).
 */
async function loadOwningAgentOrgScope(
  client: pg.PoolClient,
  instructionId: string,
  tenantId: string,
): Promise<ScopeElement> {
  const { rows } = await client.query<{ department_id: string | null }>(
    `SELECT p.department_id
       FROM choros.agent_instruction ai
       JOIN choros.employee e
         ON e.tenant_id = ai.tenant_id AND e.id = ai.employee_id
       LEFT JOIN choros.position p
         ON p.tenant_id = e.tenant_id AND p.id = e.position_id
      WHERE ai.tenant_id = $1 AND ai.id = $2
      LIMIT 1`,
    [tenantId, instructionId],
  );
  const deptId = rows[0]?.department_id ?? null;
  if (deptId) {
    return { kind: "node", hierarchy: "org", nodeId: deptId, nodeLevel: "department" };
  }
  return { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" };
}

/**
 * T-0645 [SECURITY]: agent_instruction promotion authority = the SAME predicate as
 * saving its draft (mgmt_object:agent/update over the owning agent), REPLACING the
 * generic tier_promote gate for this artifact type ONLY. Reuses the shared
 * `holdsAgentMgmtUpdate` resolver (genesis-owner short-circuit inside).
 */
async function checkAgentInstructionAuthority(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  instructionId: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
  return withTenantTx(pool, tenantId, async (client) => {
    const agentOrgScope = await loadOwningAgentOrgScope(client, instructionId, tenantId);
    // Oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      return { ok: true };
    }
    return { ok: false, reason: "no_agent_update_authority" };
  });
}

async function defaultCheckTierPromoteGrant(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  nowMs: number,
  ctx: { artifactTable: string; artifactId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // T-0645: agent_instruction is the live LLM system prompt — promoting it is the
  // SAME management operation as authoring its draft, so it is gated on scoped
  // agent/update authority over the OWNING agent (NOT the generic tier_promote that
  // grant/registry/app publishing shares).
  if (ctx.artifactTable === "agent_instruction") {
    return checkAgentInstructionAuthority(pool, tenantId, actorId, ctx.artifactId, nowMs);
  }

  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  // Genesis owner is the un-parented delegation root — always allowed (T-0029 §2 step 3).
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // For non-owners: check adminGrants for mgmt_object:tier_promote / transition.
  // loadAdminContext fetches all LIKE 'mgmt_object:%' delegable grants.
  const hasCovering = admin.adminGrants.some(
    (g) =>
      g.delegable &&
      g.resourceType === "mgmt_object:tier_promote" &&
      (g.operation as string) === "transition",
  );

  if (!hasCovering) {
    return { ok: false, reason: "no_tier_promote_authority" };
  }
  return { ok: true };
}

const defaultArtifactAuthzDeps: ArtifactAuthzDeps = {
  checkTierPromoteGrant: defaultCheckTierPromoteGrant,
};

// ---------------------------------------------------------------------------
// extractActorWithType — derives actor id + actorType from the request.
//
// In keycloak mode: reads from getAuthContext (the authenticated JWT claim).
// In dev mode: reads x-dev-user header and looks up employee.type from the DB/seed.
//
// actor_type NEVER comes from the request body (T-0044 §9 / ADR §4.3).
// ---------------------------------------------------------------------------

async function extractActorWithType(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<{ actor: string; actorType: "human" | "agent" }> {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  // The JWT `sub` is the KC user UUID, NOT the employee slug; resolve it to the
  // slug (T-0489 / T-0372, kind='human') so tenant resolution + the audit `actor`
  // use the real employee identity. null ⇒ fail closed (401).
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    // actorType comes from the AUTHENTICATED JWT claim (never the body — T-0044 §9).
    return { actor: slug, actorType: ctx.actorType };
  }

  // Dev mode: resolve identity from x-dev-user header + employee record.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  const actor = devUser;

  // Derive actorType from the employee record (human vs agent).
  const emp = await findEmployee(actor);
  const actorType: "human" | "agent" = emp?.type === "agent" ? "agent" : "human";

  return { actor, actorType };
}

// ---------------------------------------------------------------------------
// Supported artifact tables (config class only — ADR §4.1)
// ---------------------------------------------------------------------------

const CONFIG_TABLES = new Set(["application", "registry_def", "grant", "agent_instruction"]);

/**
 * Validates that `table` is a promotable config-artifact table.
 * Returns the quoted SQL table name (grant is a reserved word).
 */
function resolveArtifactTable(table: string): string {
  if (!CONFIG_TABLES.has(table)) {
    throw new HttpError(
      400,
      "VALIDATION",
      `artifact_table must be one of: ${[...CONFIG_TABLES].join(", ")}`,
    );
  }
  // `grant` is a SQL reserved word → must be double-quoted.
  return table === "grant" ? `choros."grant"` : `choros.${table}`;
}

// ---------------------------------------------------------------------------
// promoteTier — the transactional promote service (ADR §4.3)
// ---------------------------------------------------------------------------

/**
 * Atomically flips the artifact's tier to 'published' and appends an
 * artifact.promoted audit row in the SAME transaction (NF-2 / NF-3 / AC-4 / AC-5).
 *
 * Sets SET LOCAL choros.promoting='1' to unlock the tier_published_locked DB trigger
 * for this transaction only (ADR §4.2b). The GUC reverts on COMMIT/ROLLBACK.
 *
 * Config-only (FR-3 / AC-3): touches only the artifact row's tier column.
 * No INSERT/UPDATE on choros.record or any data table.
 *
 * decidePromote is called with the REAL currentTier read via FOR UPDATE (ADR §4.3):
 * this means both the agent gate and the NOT_IN_DRAFT guard run against the live row,
 * making the NOT_IN_DRAFT path reachable when a published artifact is re-promoted.
 */
// T-0465: exported so the bundle-promote endpoint (solution-bundles.ts) flips
// app/registry_def tier through THIS sanctioned module (FF-10: tier='published'
// is assigned ONLY in env-tier.ts / artifacts.ts). The bundle endpoint must NOT
// write tier='published' itself — it calls promoteTier per bundle item.
export async function promoteTier(args: {
  pool: pg.Pool;
  tenantId: string;
  artifactTable: string;    // validated config table name (e.g. "application")
  artifactId: string;       // uuid
  actor: string;
  actorType: "human" | "agent";
  nowMs: number;
}): Promise<void> {
  const { pool, tenantId, artifactId, actor, actorType, nowMs } = args;
  const quotedTable = resolveArtifactTable(args.artifactTable);
  const writer = makePgAuditWriter();

  await withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 1. Lock the artifact row and read its current tier.
    const rowRes = (await client.query(
      `SELECT tier FROM ${quotedTable} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, artifactId],
    )) as { rows: Array<{ tier: string }> };

    if (rowRes.rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "artifact not found");
    }

    const currentTier = rowRes.rows[0]!.tier as "draft" | "published";

    // 1b. decidePromote with the REAL currentTier from the DB (ADR §4.3).
    //     This makes both code paths reachable:
    //       - actorType=agent            → FORBIDDEN_AGENT_SELF_PROMOTE → 403
    //       - currentTier='published'    → NOT_IN_DRAFT                → 409
    //       - currentTier='draft'+human  → ok                          → proceed
    const decision = decidePromote({ currentTier, actorType });
    if (!decision.ok) {
      if (decision.code === "FORBIDDEN_AGENT_SELF_PROMOTE") {
        throw new HttpError(403, "FORBIDDEN_AGENT_SELF_PROMOTE", "agents cannot self-promote");
      }
      // NOT_IN_DRAFT: artifact is already published (idempotent re-promote → 409).
      throw new HttpError(409, "NOT_IN_DRAFT", "artifact is already published");
    }

    // 2. Unlock the trigger for THIS transaction (ADR §4.2b).
    await client.query("SET LOCAL choros.promoting = '1'");

    // 3. Flip tier — config-only. No writes to record/instances/audit-data.
    await client.query(
      `UPDATE ${quotedTable} SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, artifactId],
    );

    // 4. Append audit row atomically in the same transaction (NF-3 / AC-5).
    const auditInput = {
      id: randomUUID(),
      type: "artifact.promoted",
      actor,
      subject: artifactId,
      scope: { artifact_table: args.artifactTable, id: artifactId },
      via: "tier-promote",
      proposed_by: null,
      confirmed_by: actor,   // the authenticated human confirmer (AC-5)
      payload: {
        artifact_table: args.artifactTable,
        tier_from: "draft",
        tier_to: "published",
      },
      occurred_at: nowMs,
    };

    // The writer is passed the pg.PoolClient which satisfies PgClientLike.
    await writer.appendAuditEvent(client as unknown as PgClientLike, auditInput);

    // 5. COMMIT — tier flip + audit row land together, or neither does (NF-2 / AC-4).
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Reset the module-level pool singleton.
 * FOR TESTING ONLY — allows tests to inject a controlled pool without live DB.
 */
export function resetPoolForTesting(): void {
  _pool = null;
}

/**
 * T-0489 [SECURITY]: optional deps. `resolveActorTenant` derives the tenant from
 * the actor's OWN row (resolveActorTenant(getOrgPool(), slug), fail-closed) so the
 * promote runs in the caller's REAL tenant instead of the hardcoded Dev Silo. When
 * omitted, DEV_TENANT_ID is used (legacy / no-DB honest-degrade path unchanged).
 *
 * T-0513 [SECURITY]: `authzDeps` is the injectable PDP gate for the promote
 * authority check. When omitted, the default loadAdminContext-based implementation
 * is used (fail-closed: 403 unless the actor is genesis-owner or holds the
 * mgmt_object:tier_promote/transition grant).
 */
export interface ArtifactRoutesDeps {
  resolveActorTenant?: (actorSlug: string) => Promise<string>;
  authzDeps?: ArtifactAuthzDeps;
}

export function registerArtifactRoutes(
  router: Router,
  deps: ArtifactRoutesDeps = {},
  _poolHint?: import("pg").Pool,
): void {
  const { resolveActorTenant, authzDeps = defaultArtifactAuthzDeps } = deps;
  /**
   * POST /api/artifacts/:id/promote
   *
   * Body (optional): { artifact_table: "application"|"registry_def"|"grant" }
   *   Defaults to "application" when absent (day-1 convenience).
   *
   * R-AUTH: actor_type is read from the AUTHENTICATED claim (getAuthContext /
   * x-dev-user+employee.type). The request body MUST NOT supply actor_type,
   * is_human, or confirmed_by as gate inputs (T-0044 §9 / FF-7 lint target).
   *
   * T-0489 G2: wrapped in withAuth at the registration site — keycloak mode REQUIRES
   * a valid Bearer (401 otherwise; x-dev-user no longer bypasses); dev mode is a
   * no-op pass-through. Closes the http-route-auth-coverage [KNOWN-GAP] allowlist entry.
   *
   * Returns 200 { promoted: true, artifact_id, artifact_table, tier: "published" }
   * on success.
   */
  router.register("POST", "/api/artifacts/:id/promote", withAuth(async (req, res, params) => {
    const artifactId = params["id"] ?? "";
    assertUuidShape(artifactId, "artifact id");

    const pool = _poolHint ?? getPool();

    // 1. Extract actor + actorType from AUTHENTICATED source only.
    //    actorType is from the authenticated claim; NEVER from the body (T-0044 §9).
    const { actor, actorType } = await extractActorWithType(req, pool);

    // T-0489 [SECURITY]: tenant from the actor's OWN identity (fail-closed) when a
    // resolver is wired; never a request-supplied tenant. Falls back to DEV_TENANT_ID.
    const tenantId = resolveActorTenant ? await resolveActorTenant(actor) : DEV_TENANT_ID;

    // 3. Parse artifact_table from body (optional; default "application").
    let artifactTable = "application";
    if (req.headers["content-type"]?.includes("application/json")) {
      try {
        const raw: unknown = await new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          let total = 0;
          req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 65536) { reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "body too large")); }
            chunks.push(chunk);
          });
          req.on("error", () => reject(new HttpError(400, "INVALID_JSON", "read error")));
          req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch { reject(new HttpError(400, "INVALID_JSON", "invalid JSON")); }
          });
        });
        if (raw !== null && typeof raw === "object") {
          const b = raw as Record<string, unknown>;
          if (typeof b["artifact_table"] === "string") {
            artifactTable = b["artifact_table"] as string;
          }
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // No body or non-JSON → use default.
      }
    }

    // Validate artifact_table is a config table (not record — data class).
    if (!CONFIG_TABLES.has(artifactTable)) {
      throw new HttpError(
        400,
        "VALIDATION",
        `artifact_table must be one of: ${[...CONFIG_TABLES].join(", ")}`,
      );
    }

    // 4. AUTHORITY CHECK (ADR §4.5 / T-0513 security fix):
    //    gate on mgmt_object:tier_promote / transition (mirrors report-pages.ts promote gate).
    //    Genesis-owner short-circuit; non-owners need an explicit delegated grant.
    //    T-0645 [SECURITY]: for artifact_table='agent_instruction' the default gate
    //    instead requires scoped mgmt_object:agent/update over the OWNING agent (the
    //    SAME right saveDraft needs) — closing the T-0637 publish-weaker-than-draft gap.
    //    Fail-closed: 403 NO_PROMOTE_GRANT when the actor lacks authority.
    const gateResult = await authzDeps.checkTierPromoteGrant(
      pool,
      tenantId,
      actor,
      Date.now(),
      { artifactTable, artifactId },
    );
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_PROMOTE_GRANT", "mgmt_object:tier_promote/transition denied");
    }

    // 5. Promote (transactional: tier flip + audit row).
    //    actorType is passed into promoteTier so decidePromote runs with the real
    //    currentTier from the DB (ADR §4.3 — NOT_IN_DRAFT path is live).
    //    tenantId is the actor's resolved tenant (T-0489), not the hardcoded silo.
    await promoteTier({
      pool,
      tenantId,
      artifactTable,
      artifactId,
      actor,
      actorType,
      nowMs: Date.now(),
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        promoted: true,
        artifact_id: artifactId,
        artifact_table: artifactTable,
        tier: "published",
      }),
    );
  }));
}
