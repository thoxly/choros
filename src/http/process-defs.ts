/**
 * src/http/process-defs.ts
 *
 * T-0252 E8 C2: Process-definition CRUD + publish routes.
 * T-0377 (B19): Auto-assign process key on first save.
 *
 * Routes:
 *   POST   /api/process-defs            — upsert draft from XML (auth-gated write)
 *                                         processKey is optional: when absent, a
 *                                         collision-safe slug is auto-generated from name.
 *   GET    /api/process-defs            — list all definitions for the tenant
 *   GET    /api/process-defs/:key       — get latest version for a process key
 *   POST   /api/process-defs/:key/publish — lint → deployBpmn → persist deployment_id
 *
 * Design invariants:
 *   - Auth via x-dev-user convention (same as binding.ts).
 *   - T-0468 [SECURITY]: the tenant is resolved from the AUTHENTICATED IDENTITY
 *     (extractActor → resolveActorTenant), exactly like applications.ts — NEVER
 *     from an attacker-controlled x-tenant-id header. Trusting the client header
 *     allowed a caller in tenant A to read/write tenant B's process_definition
 *     rows; defense-in-depth closes that even though RLS would also bite. ALL
 *     routes (reads included) are withAuth-wrapped so the identity is established
 *     before tenant resolution.
 *   - Tenant isolation via withTenantTx + FORCE RLS (same as binding.ts / invoke.ts).
 *   - FlowableClient injected via composition root (NO env reads in core — NF-1).
 *   - lintBpmn called before any deploy attempt; ok:false → HTTP 422 with violations.
 *   - Publish is the ONLY path that calls deployBpmn; CRUD never touches the engine.
 *   - Upsert semantics: same (tenant_id, process_key) → new version row (version+1).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { generateUniqueProcessKey } from "../core/slugify-process-key.js";
import { mapLanesToCandidateGroups } from "../core/lane-role-mapper.js";
import { lintBpmn } from "../core/bpmn-linter.js";
import { flowableErrorToHttp, type FlowableClient } from "../core/flowable-client.js";
import { getHoldersForRole } from "../db/grants-dao.js";
import { loadPublishedRuleTables } from "../db/dmn-rule-table-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessDefRow {
  tenant_id: string;
  id: string;
  process_key: string;
  name: string;
  bpmn_xml: string;
  version: number;
  status: string;
  deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the tenant the actor (resolved slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug) from src/db/org.ts;
 * injected (mirrors applications.ts / process-start.ts) so the test suite can stub
 * the membership check without standing up the org DB / Keycloak. T-0468: this is
 * the ONLY source of truth for the tenant — never a request header.
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// T-0418 [SECURITY] P0: mode-aware caller identity (mirrors binding.ts::extractActorSlug).
// process-defs writes are an SPA human (process_designer) surface. The write routes are
// now withAuth-wrapped (Bearer validated + getAuthContext populated BEFORE this runs).
//   - keycloak: identity from the VALIDATED token (sub/preferred_username → slug); null
//     → 401 fail-closed. x-dev-user is NOT consulted once a token authenticated.
//   - dev: getAuthContext is undefined (withAuth no-op) → x-dev-user, unchanged.
async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
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

// withTenantTx — same RLS pattern as binding.ts
async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
  }
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
// T-0380 (D4/F7): Authoring-time role warning helper.
//
// At publish time: extract all candidateGroups referenced by userTask elements
// in the BPMN XML, then check each against the DB. Any role with no confirmed
// holders produces a WARNING (not a block — fallback covers it per spec §4.4/F7).
//
// Returns an array of warning strings. Empty = all roles have holders.
// ---------------------------------------------------------------------------

/**
 * Extract all unique candidateGroups values from a BPMN XML string.
 * Matches `candidateGroups="..."` attributes on userTask elements.
 * Pure (no IO).
 */
function extractCandidateGroupsFromBpmn(bpmnXml: string): string[] {
  const seen = new Set<string>();
  // Match candidateGroups="value1,value2" in any context (userTask or extension).
  // Comma-separated: split and trim each slug.
  const re = /candidateGroups\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bpmnXml)) !== null) {
    const rawValue = m[1];
    if (rawValue) {
      for (const slug of rawValue.split(",")) {
        const trimmed = slug.trim();
        if (trimmed) seen.add(trimmed);
      }
    }
  }
  return Array.from(seen);
}

/**
 * T-0380 (F7): Build publish warnings for unfilled roles.
 * For each candidateGroups slug in the BPMN, check if there are confirmed holders.
 * Returns warning strings for roles with no holders (not a block — warning only).
 * Degrades gracefully: DB errors are non-fatal (returns empty warnings array).
 */
async function buildUnfilledRoleWarnings(
  pool: pg.Pool,
  tenantId: string,
  bpmnXml: string,
): Promise<string[]> {
  const roleSlugsCandidates = extractCandidateGroupsFromBpmn(bpmnXml);
  if (roleSlugsCandidates.length === 0) return [];

  const nowMs = Date.now();
  const warnings: string[] = [];
  for (const roleSlug of roleSlugsCandidates) {
    try {
      const holders = await getHoldersForRole(pool, tenantId, roleSlug, nowMs);
      if (holders.length === 0) {
        warnings.push(
          `роль '${roleSlug}' не заполнена — задача уйдёт исполнителю по умолчанию (владельцу тенанта)`,
        );
      }
    } catch {
      // Degrade gracefully — DB error checking holders is non-fatal for publish.
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

async function getLatestVersion(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
): Promise<ProcessDefRow | null> {
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1 AND process_key = $2
      ORDER BY version DESC
      LIMIT 1`,
    [tenantId, processKey],
  );
  return rows[0] ?? null;
}

async function listAll(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessDefRow[]> {
  // Return only the latest version per process_key using DISTINCT ON
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT DISTINCT ON (process_key)
            tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1
      ORDER BY process_key, version DESC`,
    [tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProcessDefsRoutes(
  router: Router,
  pool: pg.Pool,
  flowable: FlowableClient,
  resolveActorTenant: ActorTenantResolver,
): void {

  // -------------------------------------------------------------------------
  // POST /api/process-defs — upsert draft
  // Body: { processKey?: string, name: string, bpmnXml: string }
  //
  // T-0377 (B19): processKey is now OPTIONAL.
  // When absent (new process), a collision-safe slug is auto-generated from `name`
  // (Cyrillic-aware transliteration: "Согласование" → "soglasovanie") and returned
  // in the response as `assignedKey`. The frontend uses this to update the URL.
  // When present (editing existing), standard upsert-by-version semantics apply.
  // -------------------------------------------------------------------------
  // T-0418 [SECURITY] P0: withAuth-wrapped write — keycloak REQUIRES a valid Bearer
  // (401 otherwise; no x-dev-user bypass); dev mode is a no-op pass-through.
  router.register("POST", "/api/process-defs", withAuth(async (req, res) => {
    // Auth gate — actor derived from the validated token (keycloak) or x-dev-user (dev).
    // T-0468 [SECURITY]: tenant from the actor's identity, NOT an x-tenant-id header.
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    // processKey is optional — when absent, we auto-generate from name.
    const requestedKey = body["processKey"];
    const name = body["name"];
    const rawBpmnXml = body["bpmnXml"];

    if (typeof name !== "string" || !name.trim()) {
      throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
    }
    if (typeof rawBpmnXml !== "string" || !rawBpmnXml.trim()) {
      throw new HttpError(400, "VALIDATION", "bpmnXml must be a non-empty string");
    }

    // T-0457 [D8-R2]: lane → role wiring. Before persisting, map each visual
    // swimlane to the candidateGroups of the userTasks inside it (spec §3.3):
    // a userTask in lane «Бухгалтер» gets flowable:candidateGroups="<lane-role>".
    // Idempotent and additive — userTasks with an explicit role are left as-is,
    // and a diagram with no lanes is returned unchanged. The persisted draft
    // therefore carries the role binding the executor-resolver consumes.
    const bpmnXml = mapLanesToCandidateGroups(rawBpmnXml);

    // T-0377: resolve the final key — explicit or auto-generated.
    let resolvedKey: string;
    if (typeof requestedKey === "string" && requestedKey.trim()) {
      // Caller provided a key — use as-is (editing existing process).
      resolvedKey = requestedKey.trim();
    } else {
      // New process — generate a collision-safe slug from the name.
      resolvedKey = await generateUniqueProcessKey(name, async (candidate) => {
        // Check for collision inside a read-only transaction.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          const existing = await getLatestVersion(client, tenantId, candidate);
          await client.query("COMMIT");
          return existing !== null;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      });
    }

    const nowMs = Date.now();

    const result = await withTenantTx(pool, tenantId, async (client) => {
      const existing = await getLatestVersion(client, tenantId, resolvedKey);
      const newVersion = existing ? existing.version + 1 : 1;
      const newId = randomUUID();

      await client.query(
        `INSERT INTO choros.process_definition
           (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', NULL, $7, $7)`,
        [tenantId, newId, resolvedKey, name, bpmnXml, newVersion, nowMs],
      );
      // assignedKey is always returned (equals processKey for existing definitions).
      return { id: newId, processKey: resolvedKey, assignedKey: resolvedKey, version: newVersion, status: "draft" };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  }));

  // -------------------------------------------------------------------------
  // GET /api/process-defs — list latest version per process key
  // T-0468 [SECURITY]: withAuth-wrapped + tenant resolved from identity. A read of
  // another tenant's definitions via a forged x-tenant-id is no longer possible.
  // -------------------------------------------------------------------------
  router.register("GET", "/api/process-defs", withAuth(async (req, res) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);

    const rows = await withTenantTx(pool, tenantId, async (client) => {
      return listAll(client, tenantId);
    });

    const items = rows.map((r) => ({
      id: r.id,
      processKey: r.process_key,
      name: r.name,
      version: r.version,
      status: r.status,
      deploymentId: r.deployment_id ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items }));
  }));

  // -------------------------------------------------------------------------
  // GET /api/process-defs/:key — get latest version for a process key
  // T-0468 [SECURITY]: withAuth-wrapped + tenant resolved from identity (not header).
  // -------------------------------------------------------------------------
  router.register("GET", "/api/process-defs/:key", withAuth(async (req, res, params) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const processKey = decodeURIComponent(params["key"] ?? "");
    if (!processKey) {
      throw new HttpError(400, "VALIDATION", "process key must be non-empty");
    }

    const row = await withTenantTx(pool, tenantId, async (client) => {
      return getLatestVersion(client, tenantId, processKey);
    });

    if (!row) {
      throw new HttpError(404, "NOT_FOUND", `process definition '${processKey}' not found`);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: row.id,
      processKey: row.process_key,
      name: row.name,
      bpmnXml: row.bpmn_xml,
      version: row.version,
      status: row.status,
      deploymentId: row.deployment_id ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/process-defs/:key/publish — lint → deploy → persist
  //
  // Steps:
  //   1. Load latest version from DB (404 if not found)
  //   2. lintBpmn(bpmnXml) — ok:false → 422 with violations
  //   3. flowable.deployBpmn(bpmnXml) — failure → 502
  //   4. UPDATE status='published', deployment_id=deploymentId, updated_at=now
  //   5. Return { id, processKey, version, status, deploymentId }
  // -------------------------------------------------------------------------
  // T-0418 [SECURITY] P0: withAuth-wrapped write — keycloak REQUIRES a valid Bearer.
  router.register("POST", "/api/process-defs/:key/publish", withAuth(async (req, res, params) => {
    // Auth gate — write operation; actor from validated token (keycloak) or x-dev-user (dev).
    // T-0468 [SECURITY]: tenant from the actor's identity, NOT an x-tenant-id header.
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const processKey = decodeURIComponent(params["key"] ?? "");
    if (!processKey) {
      throw new HttpError(400, "VALIDATION", "process key must be non-empty");
    }

    // Step 1: Load latest version
    const row = await withTenantTx(pool, tenantId, async (client) => {
      return getLatestVersion(client, tenantId, processKey);
    });

    if (!row) {
      throw new HttpError(404, "NOT_FOUND", `process definition '${processKey}' not found`);
    }

    // Step 2: Lint — fail-closed gate (T-0027 deploy-gate-contract)
    // T-0436: load published rule tables for this process and pass to lintBpmn
    // for publish-time gateway↔rule-table coherence check.
    // Uses a short-lived tenant-scoped client (same RLS pattern as other reads).
    let ruleTables: import("../core/dmn-middle.js").DmnRuleTable[] | undefined;
    try {
      const { tables } = await withTenantTx(pool, tenantId, async (client) => {
        return loadPublishedRuleTables(client, tenantId, processKey);
      });
      ruleTables = tables;
    } catch (err) {
      // Degrade gracefully: if rule table load fails (e.g. table not yet migrated
      // on older deployment), skip the coherence check rather than blocking publish.
      // The coherence check is advisory at this stage of rollout.
      console.warn(
        `[process-defs] publish ${processKey}: loadPublishedRuleTables failed — ` +
        `skipping gateway coherence check. Reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      ruleTables = undefined;
    }

    const lintResult = lintBpmn(row.bpmn_xml, ruleTables !== undefined ? { ruleTables } : undefined);
    if (!lintResult.ok) {
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: { code: "BPMN_LINT_FAILED", violations: lintResult.violations },
      }));
      return;
    }

    // Step 3: Deploy to Flowable
    // T-0483: surface a CLEAR, TYPED error to the client instead of an opaque 502.
    // ENGINE_UNAVAILABLE/TIMEOUT → 503 with code "ENGINE_UNAVAILABLE" + honest message
    // so the modeler keeps the diagram a ЧЕРНОВИК and shows "движок недоступен"
    // (never a green "опубликовано"). The diagram stays unpublished (no DB update below).
    const deployResult = await flowable.deployBpmn(row.bpmn_xml);
    if (!deployResult.ok) {
      const { status, code, message } = flowableErrorToHttp(deployResult.code);
      throw new HttpError(status, code, message);
    }

    const deploymentId = deployResult.deploymentId;
    const nowMs = Date.now();

    // Step 4: Persist publication
    await withTenantTx(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE choros.process_definition
            SET status = 'published',
                deployment_id = $1,
                updated_at = $2
          WHERE tenant_id = $3
            AND id = $4`,
        [deploymentId, nowMs, tenantId, row.id],
      );
    });

    // Step 5: T-0380 (F7): check for unfilled roles — WARNING, not block.
    // The fallback-executor resolver covers unfilled roles at runtime (spec §4.4),
    // so we do NOT block publication. We surface warnings so the author knows.
    // Degrades gracefully: DB errors → empty warnings (publish still succeeds).
    const roleWarnings = await buildUnfilledRoleWarnings(pool, tenantId, row.bpmn_xml);

    // Step 6: Respond
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: row.id,
      processKey: row.process_key,
      version: row.version,
      status: "published",
      deploymentId,
      // Additive: only present when there are role warnings (non-breaking).
      ...(roleWarnings.length > 0 ? { warnings: roleWarnings } : {}),
    }));
  }));
}
