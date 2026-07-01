/**
 * src/http/solution-publish.ts — T-0562 (PD-26 / ADR T-0561): «Опубликовать
 * связанное решение по кнопке» BACKEND.
 *
 * The founder scenario: a solution is rarely a single application — it's an app
 * plus its справочники (related applications linked via x-relation) plus the
 * processes bound to it plus those processes' step forms. The user tests e2e
 * ALL together and publishes together, then edits a piece and re-publishes.
 *
 * Two routes over the EXISTING application/registry_def/process primitives —
 * NO new «Решение» entity (PD-26: derived + transparent, граница = связи):
 *
 *   GET  /api/applications/:id/publish-preview
 *     Derive the connected set (1 hop, NOT transitive) and report each item's
 *     current tier + whether it would publish. A confirm-list before the action.
 *
 *   POST /api/applications/:id/publish-solution
 *     Promote each DRAFT item, REUSING the sanctioned machinery:
 *       - application / registry_def → promoteTier (artifacts.ts, T-0087) — the
 *         SAME config tier flip the per-artifact promote endpoint uses.
 *       - process                    → publishProcessByKey (process-defs.ts, T-0465)
 *         — the SAME lint → deploy → persist path the modeler publish uses.
 *     NO stored 'partial' state (PD-26 #4): the response IS the truth. Per-item
 *     { ok, error }. 200 all-ok, 207 partial. Already-published → skip (ok:true).
 *
 * DERIVE (1 hop, ADR §2.1):
 *   - the app itself
 *   - applications it DIRECTLY references: for each registry_def under the app,
 *     the x-relation fields' target_registry_id → owning application_id.
 *   - processes bound to the app: process_app_binding by application_id.
 *   - step forms of those processes: form_binding by process_key (+ the binding's
 *     own form_key / start_form_key). Forms have NO independent tier (migration
 *     045) — they ride the process's publish state: tier = owning process status,
 *     will_publish = that process is still draft. Publishing a form is therefore a
 *     no-op that mirrors its process's result (published-with-process).
 *
 * TENANCY / RLS: both routes withAuth + resolveActorTenant (NEVER a header) +
 * withTenantTx (SET LOCAL choros.tenant_id + FORCE RLS). A caller in tenant A
 * cannot preview or publish tenant B's solution.
 *
 * AUTHZ (privileged): publishing (and previewing a draft solution) is owner/admin
 * OR an authoring_draft grant holder ONLY (reuse resolveActorPrivilege, T-0557).
 * A non-privileged actor → 403 (they must not even enumerate a draft solution).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { resolveActorPrivilege } from "../db/sandbox-gate-dao.js";
import { extractRelationFields } from "./registry-defs.js";
import { promoteTier } from "./artifacts.js";
import { publishProcessByKey } from "./process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

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

// ---------------------------------------------------------------------------
// Injected deps (mirrors ApplicationRoutesDeps + SolutionBundleDeps)
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * The privilege check — reuses resolveActorPrivilege (owner/admin OR
 * authoring_draft). Injectable so unit tests can drive privileged/non-privileged
 * without standing up the grant tables; the composition root passes the real one.
 */
export type PrivilegeResolver = (
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs?: number,
) => Promise<{ isOwnerOrAdmin: boolean; hasAuthoringDraftGrant: boolean }>;

export interface SolutionPublishDeps {
  pool: pg.Pool;
  flowable: FlowableClient;
  resolveActorTenant: ActorTenantResolver;
  /** Defaults to the real resolveActorPrivilege; override in tests. */
  resolvePrivilege?: PrivilegeResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts)
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
// extractActor — mode-aware (keycloak: sub→slug; dev: x-dev-user)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Derived connected set (1 hop)
// ---------------------------------------------------------------------------

type ItemKind = "application" | "process" | "form";

interface DerivedItem {
  readonly kind: ItemKind;
  /** application/form: uuid or form_key. process: process_key. */
  readonly id: string;
  readonly name: string;
  /** Current tier/status: 'draft' | 'published'. */
  readonly tier: "draft" | "published";
  readonly will_publish: boolean;
  /**
   * For process/registry_def/application: the concrete row id used to promote.
   * For forms: the owning process_key (forms ride the process publish).
   */
  readonly promoteRef: {
    kind: "application" | "registry_def" | "process" | "form_rides_process";
    ref: string; // artifact uuid, process_key, or the owning process_key for a form
  };
}

interface DeriveResult {
  readonly appName: string;
  readonly items: DerivedItem[];
}

/**
 * Derive the connected set for `appId` inside an already-open tenant-tx client.
 *
 * Returns null when the target application does not exist in the caller's tenant
 * (RLS-filtered / absent) → the route maps that to 404.
 */
async function deriveConnectedSet(
  client: pg.PoolClient,
  tenantId: string,
  appId: string,
): Promise<DeriveResult | null> {
  // --- The app itself ------------------------------------------------------
  const appRes = await client.query<{ id: string; display_name: string; tier: string }>(
    `SELECT id, display_name, tier
       FROM choros.application
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [tenantId, appId],
  );
  const appRow = appRes.rows[0];
  if (!appRow) return null;

  const items: DerivedItem[] = [];
  const seenApps = new Set<string>();

  const pushApp = (row: { id: string; display_name: string; tier: string }): void => {
    if (seenApps.has(row.id)) return;
    seenApps.add(row.id);
    const tier = row.tier === "published" ? "published" : "draft";
    items.push({
      kind: "application",
      id: row.id,
      name: row.display_name,
      tier,
      will_publish: tier === "draft",
      promoteRef: { kind: "application", ref: row.id },
    });
  };

  pushApp(appRow);

  // --- Applications DIRECTLY referenced via x-relation (1 hop) -------------
  // The app's registry_defs carry record_schema; each x-relation field points at
  // a target registry_def; that registry_def's application_id is the referenced app.
  const regRes = await client.query<{ record_schema: unknown }>(
    `SELECT record_schema
       FROM choros.registry_def
      WHERE tenant_id = $1 AND application_id = $2`,
    [tenantId, appId],
  );
  const targetRegistryIds = new Set<string>();
  for (const r of regRes.rows) {
    for (const rel of extractRelationFields(r.record_schema)) {
      targetRegistryIds.add(rel.targetRegistryId);
    }
  }
  if (targetRegistryIds.size > 0) {
    // Resolve target registry_defs → their owning applications (1 hop). Only apps
    // OTHER than the source count as referenced справочники (self-links ignored).
    const relatedRes = await client.query<{ id: string; display_name: string; tier: string }>(
      `SELECT DISTINCT a.id, a.display_name, a.tier
         FROM choros.registry_def rd
         JOIN choros.application a
           ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
        WHERE rd.tenant_id = $1
          AND rd.id = ANY($2::uuid[])`,
      [tenantId, [...targetRegistryIds]],
    );
    for (const row of relatedRes.rows) {
      if (row.id === appId) continue; // self-reference is not a separate справочник
      pushApp(row);
    }
  }

  // --- Processes bound to the app (process_app_binding.application_id) ------
  const bindRes = await client.query<{
    process_key: string;
    form_key: string | null;
    start_form_key: string | null;
  }>(
    `SELECT process_key, form_key, start_form_key
       FROM choros.process_app_binding
      WHERE tenant_id = $1 AND application_id = $2`,
    [tenantId, appId],
  );

  const processKeys = new Set<string>();
  // form_key → owning process_key (a form rides the publish of its process).
  const formToProcess = new Map<string, string>();
  for (const b of bindRes.rows) {
    processKeys.add(b.process_key);
    if (b.form_key) formToProcess.set(b.form_key, b.process_key);
    if (b.start_form_key) formToProcess.set(b.start_form_key, b.process_key);
  }

  // Process status (draft/published) from the latest version per key.
  const processStatus = new Map<string, "draft" | "published">();
  const processName = new Map<string, string>();
  if (processKeys.size > 0) {
    const procRes = await client.query<{ process_key: string; name: string; status: string }>(
      `SELECT DISTINCT ON (process_key) process_key, name, status
         FROM choros.process_definition
        WHERE tenant_id = $1 AND process_key = ANY($2::text[])
        ORDER BY process_key, version DESC`,
      [tenantId, [...processKeys]],
    );
    for (const p of procRes.rows) {
      const status = p.status === "published" ? "published" : "draft";
      processStatus.set(p.process_key, status);
      processName.set(p.process_key, p.name ?? p.process_key);
    }

    // Step forms of those processes (form_binding by process_key). Add every
    // form_key so the confirm-list is honest about what the process carries.
    const formRes = await client.query<{ process_key: string; form_key: string }>(
      `SELECT process_key, form_key
         FROM choros.form_binding
        WHERE tenant_id = $1 AND process_key = ANY($2::text[])`,
      [tenantId, [...processKeys]],
    );
    for (const f of formRes.rows) {
      formToProcess.set(f.form_key, f.process_key);
    }
  }

  // Emit process items.
  for (const key of processKeys) {
    // A bound process that has no process_definition row (engine-only ТЭЛ) is
    // treated as already published — there is nothing draft to promote.
    const status = processStatus.get(key) ?? "published";
    items.push({
      kind: "process",
      id: key,
      name: processName.get(key) ?? key,
      tier: status,
      will_publish: status === "draft",
      promoteRef: { kind: "process", ref: key },
    });
  }

  // Emit form items (deduped). tier/will_publish follow the owning process.
  for (const [formKey, procKey] of formToProcess) {
    // Only surface forms whose owning process is in the derived set.
    if (!processKeys.has(procKey)) continue;
    const status = processStatus.get(procKey) ?? "published";
    items.push({
      kind: "form",
      id: formKey,
      name: formKey,
      tier: status,
      will_publish: status === "draft",
      promoteRef: { kind: "form_rides_process", ref: procKey },
    });
  }

  return { appName: appRow.display_name, items };
}

// ---------------------------------------------------------------------------
// Serialization (frozen HTTP contract shapes)
// ---------------------------------------------------------------------------

interface PreviewItemOut {
  kind: ItemKind;
  id: string;
  name: string;
  tier: "draft" | "published";
  will_publish: boolean;
}

function toPreviewItem(i: DerivedItem): PreviewItemOut {
  return { kind: i.kind, id: i.id, name: i.name, tier: i.tier, will_publish: i.will_publish };
}

// ---------------------------------------------------------------------------
// Publish one item — reuse the sanctioned promote machinery.
// ---------------------------------------------------------------------------

interface PublishResultOut {
  kind: ItemKind;
  id: string;
  name: string;
  ok: boolean;
  error: string | null;
}

/**
 * Publish a single derived item, reusing promoteTier / publishProcessByKey. Never
 * throws for a per-item failure — returns { ok:false, error } so one bad item does
 * not fail the whole request (PD-26 #4). Already-published items → { ok:true }.
 */
async function publishItem(
  deps: { pool: pg.Pool; flowable: FlowableClient },
  tenantId: string,
  actorSlug: string,
  nowMs: number,
  item: DerivedItem,
  // Cache: a form rides its process — publish each process at most once.
  processOutcome: Map<string, boolean>,
): Promise<PublishResultOut> {
  const base = { kind: item.kind, id: item.id, name: item.name };

  // Already published → skip (idempotent, ok:true).
  if (!item.will_publish) {
    return { ...base, ok: true, error: null };
  }

  try {
    if (item.promoteRef.kind === "application" || item.promoteRef.kind === "registry_def") {
      await promoteTier({
        pool: deps.pool,
        tenantId,
        artifactTable: item.promoteRef.kind,
        artifactId: item.promoteRef.ref,
        actor: actorSlug,
        actorType: "human",
        nowMs,
      });
      return { ...base, ok: true, error: null };
    }

    if (item.promoteRef.kind === "process") {
      const outcome = await runProcessPublish(deps, tenantId, item.promoteRef.ref, processOutcome);
      return { ...base, ok: outcome.ok, error: outcome.error };
    }

    // form_rides_process: publishing the form == publishing its process. Publish the
    // owning process (once, cached) and mirror its outcome onto the form item.
    if (item.promoteRef.kind === "form_rides_process") {
      const outcome = await runProcessPublish(deps, tenantId, item.promoteRef.ref, processOutcome);
      return { ...base, ok: outcome.ok, error: outcome.error };
    }

    return { ...base, ok: false, error: "UNKNOWN_ITEM_KIND" };
  } catch (err) {
    // promoteTier throws HttpError (404 not_found, 409 not_in_draft, 403 agent).
    // Surface as a per-item failure, not a whole-request failure.
    if (err instanceof HttpError) {
      // NOT_IN_DRAFT (409) means someone else already published it — treat as ok.
      if (err.code === "NOT_IN_DRAFT") {
        return { ...base, ok: true, error: null };
      }
      return { ...base, ok: false, error: err.code };
    }
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Publish one process via publishProcessByKey, caching the outcome so a process
 * and its forms trigger at most one deploy. Maps the typed PublishProcessResult
 * to { ok, error } (surfacing the T-0559 app-binding gate 422 as ok:false).
 */
async function runProcessPublish(
  deps: { pool: pg.Pool; flowable: FlowableClient },
  tenantId: string,
  processKey: string,
  cache: Map<string, boolean>,
): Promise<{ ok: boolean; error: string | null }> {
  if (cache.has(processKey)) {
    const ok = cache.get(processKey)!;
    return { ok, error: ok ? null : "PROCESS_PUBLISH_FAILED" };
  }
  const result = await publishProcessByKey(deps.pool, deps.flowable, tenantId, processKey);
  let ok = false;
  let error: string | null = null;
  switch (result.status) {
    case "published":
      ok = true;
      break;
    case "not_found":
      error = "PROCESS_NOT_FOUND";
      break;
    case "lint_failed":
      error = "BPMN_LINT_FAILED";
      break;
    case "agent_unresolved":
      error = "AGENT_REF_UNRESOLVED";
      break;
    case "app_binding_unpublished":
      error = "APP_BINDING_UNPUBLISHED";
      break;
    case "engine_unavailable":
      error = result.code;
      break;
    default:
      error = "PROCESS_PUBLISH_FAILED";
  }
  cache.set(processKey, ok);
  return { ok, error };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSolutionPublishRoutes(
  router: Router,
  deps?: SolutionPublishDeps,
): void {
  if (!deps) return;
  const { pool, flowable, resolveActorTenant } = deps;
  const resolvePrivilege: PrivilegeResolver = deps.resolvePrivilege ?? resolveActorPrivilege;

  /**
   * Privileged-actor gate. Owner/admin OR authoring_draft grant holder → pass.
   * Otherwise 403 (a non-owner must not even enumerate someone's draft solution).
   */
  async function requirePrivilege(
    req: IncomingMessage,
    nowMs: number,
  ): Promise<{ actorSlug: string; tenantId: string }> {
    const actorSlug = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actorSlug);
    const priv = await resolvePrivilege(pool, tenantId, actorSlug, nowMs);
    if (!priv.isOwnerOrAdmin && !priv.hasAuthoringDraftGrant) {
      throw new HttpError(403, "FORBIDDEN", "publishing a solution requires owner/admin or authoring_draft");
    }
    return { actorSlug, tenantId };
  }

  // -------------------------------------------------------------------------
  // GET /api/applications/:id/publish-preview
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/applications/:id/publish-preview",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const appId = params["id"] ?? "";
      assertUuidShape(appId, "application id");

      const nowMs = Date.now();
      const { tenantId } = await requirePrivilege(req, nowMs);

      const derived = await withTenantTx(pool, tenantId, (client) =>
        deriveConnectedSet(client, tenantId, appId),
      );
      if (derived === null) {
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      const items = derived.items.map(toPreviewItem);
      const toPublish = items.filter((i) => i.will_publish).length;

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          app_id: appId,
          items,
          counts: { total: items.length, to_publish: toPublish },
        }),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/applications/:id/publish-solution
  // -------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/applications/:id/publish-solution",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const appId = params["id"] ?? "";
      assertUuidShape(appId, "application id");

      const nowMs = Date.now();
      const { actorSlug, tenantId } = await requirePrivilege(req, nowMs);

      // Re-derive the set inside its own tenant-tx (the source of truth at publish
      // time; the preview is advisory). promoteTier / publishProcessByKey each open
      // their OWN tenant-tx, so the derive tx is closed before promotion begins.
      const derived = await withTenantTx(pool, tenantId, (client) =>
        deriveConnectedSet(client, tenantId, appId),
      );
      if (derived === null) {
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      const processOutcome = new Map<string, boolean>();
      const results: PublishResultOut[] = [];
      // Deterministic order: applications first (a process's T-0559 gate needs its
      // bound apps published first), then registry_defs, then processes, then forms.
      const ordered = [...derived.items].sort((a, b) => rank(a.kind) - rank(b.kind));
      for (const item of ordered) {
        results.push(
          await publishItem({ pool, flowable }, tenantId, actorSlug, nowMs, item, processOutcome),
        );
      }

      const allOk = results.every((r) => r.ok);
      res.statusCode = allOk ? 200 : 207;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ app_id: appId, results, all_ok: allOk }));
    }),
  );
}

// Publish ordering: application (0) → registry_def-as-application already flattened
// to "application" → process (1) → form (2). (registry_defs referenced via x-relation
// are surfaced as their owning "application" item, so only these three kinds appear.)
function rank(kind: ItemKind): number {
  if (kind === "application") return 0;
  if (kind === "process") return 1;
  return 2; // form
}
