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
import { mapTimerEscalation } from "../core/timer-escalation-mapper.js";
import { mapAgentTaskToExternal, extractAgentTaskConfigs } from "../core/agent-task-external-mapper.js";
import { normalizeBpmnForDeploy, InvalidProcessKeyForDeployError } from "../core/bpmn-deploy-normalizer.js";
import { lintBpmn, type LintViolation } from "../core/bpmn-linter.js";
import { flowableErrorToHttp, type FlowableClient } from "../core/flowable-client.js";
import { getHoldersForRole, filterProvisionedAgentEmployeeIds } from "../db/grants-dao.js";
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
// [SECURITY] Publish-time agentTask executor-resolution gate (D8-R5 def-in-depth).
//
// An authored agentTask binds its executor via choros:agentRef on a
// <serviceTask choros:executorType="agent">. The pure publish transform
// (mapAgentTaskToExternal) stamps that ref VERBATIM as the dispatcher's
// agentEmployeeId, and the pure (IO-free) bpmn-linter coherence guard only checks
// the ref is PRESENT — neither verifies it resolves to a real agent. So a
// process-designer (not necessarily an owner) could name a DIFFERENT, more-
// privileged in-tenant agent's id as the executor; at runtime
// assembleAgentStepContext would load THAT id's grants/toolset/criticality and the
// step would run (and write agent.proceeded) as it. Blast radius is contained — a
// human/non-agent id has no agent_card → dormant → defer with zero spend, critical-
// role ops always defer at gate B, and the agent can never exceed its own grants —
// and this mirrors the trusted-authoring posture for lane→role binding (T-0457). We
// still close the in-tenant executor-confusion gap here, at publish time, as a
// DB-backed gate kept OUT of the pure transform/linter.
//
// Rule: every authored choros:agentRef MUST resolve to a PROVISIONED kind='agent'
// employee (agent_card row) in the PUBLISHING tenant. Any ref that does not is an
// incoherent agent step → publish is rejected (HTTP 422). This is the executor-side
// analogue of the userTask candidateGroups posture: the author may only assign an
// executor that EXISTS as an agent in their OWN tenant (in-tenant provisioning is
// the entitlement boundary — consistent with how candidateGroups assignment is
// trusted within the tenant: buildUnfilledRoleWarnings warns but never blocks, and
// there is no per-author role-assignment authz beyond tenant membership to mirror).
//
// Returns LintViolation[] reusing the existing agent_task_incoherent type (an
// unresolvable executor IS an incoherent agent task) so the rejection mirrors the
// lint-failed response shape. Empty array = every ref resolves (or no agent tasks).
// ---------------------------------------------------------------------------

async function buildUnresolvedAgentRefViolations(
  pool: pg.Pool,
  tenantId: string,
  bpmnXml: string,
): Promise<LintViolation[]> {
  const refTasks = extractAgentTaskConfigs(bpmnXml).filter(
    (c) => c.agentRef.trim() !== "",
  );
  // An agent task with NO ref is already a hard lint violation
  // (agent_task_incoherent: missing agentRef) caught upstream, so by the time this
  // runs every in-scope agent step carries a present ref. Nothing to resolve → done.
  if (refTasks.length === 0) return [];

  const resolved = await filterProvisionedAgentEmployeeIds(
    pool,
    tenantId,
    refTasks.map((c) => c.agentRef.trim()),
  );

  const violations: LintViolation[] = [];
  for (const cfg of refTasks) {
    const ref = cfg.agentRef.trim();
    if (resolved.has(ref)) continue;
    const elemDesc = cfg.id ? `serviceTask id="${cfg.id}"` : "serviceTask (no id)";
    violations.push({
      type: "agent_task_incoherent",
      elementId: cfg.id,
      elementKind: "serviceTask",
      message:
        `<${elemDesc}> is an agent step whose choros:agentRef "${ref}" does not resolve ` +
        `to a provisioned agent in this tenant — pick an agent that exists here (the ` +
        `executor must be a kind='agent' employee with an agent card). Otherwise the ` +
        `dispatcher would run the step as an unintended or non-existent executor`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// T-0559: publish-coherence gate — a published (LIVE) process must not depend on a
// SANDBOX (draft) application.
//
// The constructor links a process DEFINITION to the application(s) it drives via
// choros.process_app_binding (process_key → application_id). When that process is
// published it becomes live; if a bound application is still tier='draft' (sandbox),
// the live process would read/write a sandbox app — an incoherent live↔sandbox
// dependency. We reject publish (HTTP 422) and list the offending app(s).
//
// Co-promote handling (bundle vs standalone): the bundle-promote path
// (solution-bundles.ts §1→§2) promotes the bound apps via promoteTier FIRST, then
// publishes the processes. So by the time publishProcessByKey runs inside a bundle,
// any co-promoted app is ALREADY tier='published' and passes this gate. A standalone
// modeler publish has no such pre-step, so a draft-bound app is correctly rejected.
// The gate therefore needs NO bundle-context flag: "reject if any bound app is draft
// at publish time" is exactly right for both callers (ordering verified in
// solution-bundles.ts: app promoteTier loop precedes the publishProcessByKey loop).
//
// DB read inside the existing tenant-tx / FORCE-RLS envelope. The join is by
// application_id (logical ref, no FK — same convention as the binding table). Empty
// result = no binding, or every bound app already published → no violation.
// ---------------------------------------------------------------------------

async function buildUnpublishedAppBindingViolations(
  pool: pg.Pool,
  tenantId: string,
  processKey: string,
): Promise<LintViolation[]> {
  const draftApps = await withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; slug: string; display_name: string }>(
      `SELECT a.id, a.slug, a.display_name
         FROM choros.process_app_binding b
         JOIN choros.application a
           ON a.tenant_id = b.tenant_id
          AND a.id = b.application_id
        WHERE b.tenant_id = $1
          AND b.process_key = $2
          AND a.tier = 'draft'`,
      [tenantId, processKey],
    );
    return rows;
  });

  return draftApps.map((app) => ({
    type: "app_binding_unpublished" as const,
    elementId: app.id,
    elementKind: "application",
    message:
      `This process binds application "${app.display_name}" (slug="${app.slug}") ` +
      `which is still a SANDBOX (draft) application — a published (live) process ` +
      `must not depend on a draft app. Publish/promote the application first ` +
      `(or promote both together in one solution bundle), then publish the process.`,
  }));
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
    const lanedBpmnXml = mapLanesToCandidateGroups(rawBpmnXml);

    // T-0458 [D8-R3]: timer/deadline → escalation wiring. After lanes, materialise the
    // native <timerEventDefinition> body from the typed choros:timerDeadline* config
    // (so Flowable actually schedules the timer) and stamp the escalation-target
    // userTask's flowable:candidateGroups from choros:escalateTo (so the firing
    // projection addresses the right pool — manager/owner/role). Idempotent and
    // additive: hand-authored bodies and explicit roles are preserved; a diagram with
    // no timer events is returned unchanged. Runs BEFORE lint so the linter validates
    // the materialised body.
    const timeredBpmnXml = mapTimerEscalation(lanedBpmnXml);

    // T-0460 [D8-R5]: agentTask → live agent-step external task. After lanes + timers,
    // convert each authored agent serviceTask (choros:executorType="agent") into a
    // Flowable external task on the agent-step topic and stamp the dispatcher variables
    // (agentEmployeeId←choros:agentRef, roleId, stepName, read/write fields) so the
    // already-wired D4 dispatcher fires on it. Without this the bridge never enqueues an
    // agent job. Idempotent + additive: a serviceTask already external is left untouched,
    // and a diagram with no agent tasks is returned unchanged. Runs BEFORE lint so the
    // agent_task_incoherent coherence guard validates the materialised external shape.
    const bpmnXml = mapAgentTaskToExternal(timeredBpmnXml);

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

    // T-0465: the publish flow is factored into publishProcessByKey so the
    // bundle-promote endpoint (solution-bundles.ts) can reuse the EXACT same
    // lint → deploy → persist path — co-equal with single-process publish.
    const result = await publishProcessByKey(pool, flowable, tenantId, processKey);

    if (result.status === "not_found") {
      throw new HttpError(404, "NOT_FOUND", `process definition '${processKey}' not found`);
    }
    if (result.status === "lint_failed") {
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: { code: "BPMN_LINT_FAILED", violations: result.violations },
      }));
      return;
    }
    if (result.status === "agent_unresolved") {
      // [SECURITY] 422 — an agentTask executor does not resolve to a provisioned
      // agent in this tenant. Same envelope as lint_failed, distinct code.
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: { code: "AGENT_REF_UNRESOLVED", violations: result.violations },
      }));
      return;
    }
    if (result.status === "app_binding_unpublished") {
      // T-0559: 422 — a bound application is still a sandbox (draft). A published
      // process must not depend on a draft app. Same envelope, distinct code.
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: { code: "APP_BINDING_UNPUBLISHED", violations: result.violations },
      }));
      return;
    }
    if (result.status === "engine_unavailable") {
      throw new HttpError(result.httpStatus, result.code, result.message);
    }

    // published
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: result.id,
      processKey: result.processKey,
      version: result.version,
      status: "published",
      deploymentId: result.deploymentId,
      // Additive: only present when there are role warnings (non-breaking).
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    }));
  }));
}

// ---------------------------------------------------------------------------
// publishProcessByKey — T-0465: reusable publish (lint → deploy → persist).
//
// Extracted from the POST /publish route so the bundle-promote endpoint can
// publish each process in a solution bundle through the SAME path (co-equal).
// Returns a typed result instead of writing the HTTP response, so callers
// decide how to surface success/failure (single response vs bundle aggregate).
//
// NOTE: this writes status='published' on choros.process_definition — that is the
// process publish-state field (NOT the config-tier 'tier' column). FF-10 governs
// only the config tier→published assignment; process status is unrelated.
// ---------------------------------------------------------------------------

export type PublishProcessResult =
  | { status: "not_found" }
  | { status: "lint_failed"; violations: unknown[] }
  // [SECURITY] An authored agentTask's choros:agentRef did not resolve to a
  // provisioned agent in the publishing tenant. Distinct from lint_failed (the
  // pure linter passed; this is the DB-backed executor-resolution gate), surfaced
  // with the SAME 422 envelope shape so clients render the violations identically.
  | { status: "agent_unresolved"; violations: LintViolation[] }
  // T-0559: a bound application is still tier='draft' (sandbox). A published process
  // must not depend on a draft app. Same 422 envelope as the other publish gates.
  | { status: "app_binding_unpublished"; violations: LintViolation[] }
  | { status: "engine_unavailable"; httpStatus: number; code: string; message: string }
  | {
      status: "published";
      id: string;
      processKey: string;
      version: number;
      deploymentId: string;
      warnings: string[];
    };

export async function publishProcessByKey(
  pool: pg.Pool,
  flowable: FlowableClient,
  tenantId: string,
  processKey: string,
): Promise<PublishProcessResult> {
  // Step 1: Load latest version
  const row = await withTenantTx(pool, tenantId, async (client) => {
    return getLatestVersion(client, tenantId, processKey);
  });
  if (!row) {
    return { status: "not_found" };
  }

  // Step 2: Lint — fail-closed gate (T-0027). Load published rule tables (advisory).
  let ruleTables: import("../core/dmn-middle.js").DmnRuleTable[] | undefined;
  try {
    const { tables } = await withTenantTx(pool, tenantId, async (client) => {
      return loadPublishedRuleTables(client, tenantId, processKey);
    });
    ruleTables = tables;
  } catch (err) {
    console.warn(
      `[process-defs] publish ${processKey}: loadPublishedRuleTables failed — ` +
      `skipping gateway coherence check. Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    ruleTables = undefined;
  }

  const lintResult = lintBpmn(row.bpmn_xml, ruleTables !== undefined ? { ruleTables } : undefined);
  if (!lintResult.ok) {
    return { status: "lint_failed", violations: lintResult.violations };
  }

  // Step 2.5: [SECURITY] executor-resolution gate (D8-R5 def-in-depth). Every
  // authored agentTask's choros:agentRef MUST resolve to a provisioned kind='agent'
  // employee (agent_card row) in THIS tenant. A DB read is allowed here (unlike the
  // pure transform/linter). Runs AFTER lint (which guarantees each agent step has a
  // present ref + the external-task shape) and BEFORE deploy — never deploy a
  // process whose executor is unresolved. Mirrors the lint-failed 422 envelope.
  const agentRefViolations = await buildUnresolvedAgentRefViolations(pool, tenantId, row.bpmn_xml);
  if (agentRefViolations.length > 0) {
    return { status: "agent_unresolved", violations: agentRefViolations };
  }

  // Step 2.6: [T-0559] publish-coherence gate — a published (live) process must not
  // depend on a SANDBOX (draft) application it binds via process_app_binding. DB read
  // in the tenant-tx envelope; runs AFTER agent-resolve and BEFORE deploy (never
  // deploy a live process bound to a draft app). Bundle-promote pre-promotes the bound
  // apps (solution-bundles.ts §1) so they are already published by the time the
  // process publishes within a bundle; standalone publish has no such pre-step, so a
  // draft-bound app is correctly rejected. Mirrors the lint-failed 422 envelope.
  const appBindingViolations = await buildUnpublishedAppBindingViolations(pool, tenantId, row.process_key);
  if (appBindingViolations.length > 0) {
    return { status: "app_binding_unpublished", violations: appBindingViolations };
  }

  // Step 2.7 [T-0505]: normalize for deploy. The modeler emits the process as
  // isExecutable="false" (templates) and with a bpmn-js `<process id>` (e.g.
  // "Process_1") that is unrelated to the choros process_key the start path sends
  // as processDefinitionKey. Both break publish→run: a non-executable process
  // makes Flowable answer 500 (misreported as «движок недоступен»), and the id
  // mismatch makes startInstance unable to find the definition. Force the
  // executable process to isExecutable="true" and rename its <process id> (and the
  // matching BPMNDI plane bpmnElement) to row.process_key BEFORE deploy. Pure +
  // idempotent; a no-op on a document the linter already accepted that needs no fix.
  //
  // [SECURITY] The process_key is client-supplied at draft time (POST /api/process-defs
  // accepts body.processKey with only .trim()). A key carrying XML-attribute-breaking
  // characters (quotes/angle-brackets/ampersand/whitespace) would otherwise corrupt the
  // deploy XML when injected as <process id="…">. normalizeBpmnForDeploy honest-fails on
  // such keys; map that to a 422 (NOT a 500, and NOT a deploy of corrupt XML). We do not
  // escape — the id must stay byte-equal to the key the start path sends.
  let deployBpmnXml: string;
  try {
    deployBpmnXml = normalizeBpmnForDeploy(row.bpmn_xml, row.process_key);
  } catch (err) {
    if (err instanceof InvalidProcessKeyForDeployError) {
      throw new HttpError(422, "INVALID_PROCESS_KEY", err.message);
    }
    throw err;
  }

  // Step 3: Deploy to Flowable
  const deployResult = await flowable.deployBpmn(deployBpmnXml);
  if (!deployResult.ok) {
    const { status, code, message } = flowableErrorToHttp(deployResult.code);
    return { status: "engine_unavailable", httpStatus: status, code, message };
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

  // Step 5: unfilled-role warnings (advisory, never block).
  const roleWarnings = await buildUnfilledRoleWarnings(pool, tenantId, row.bpmn_xml);

  return {
    status: "published",
    id: row.id,
    processKey: row.process_key,
    version: row.version,
    deploymentId,
    warnings: roleWarnings,
  };
}
