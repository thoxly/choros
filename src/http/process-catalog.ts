/**
 * src/http/process-catalog.ts — T-0270 (E13).
 *
 * The REAL process catalog + process↔application binding surface. This is the
 * "how processes connect to the applications you built in the constructor" view.
 *
 * Routes (ALL withAuth-wrapped + mode-aware + tenant-scoped via resolveActorTenant):
 *   GET  /api/process-catalog        → real process DEFINITIONS + real INSTANCES
 *   GET  /api/process-app-bindings   → list this tenant's process↔application bindings
 *   POST /api/process-app-bindings   → bind a process to an application (+ optional form)
 *
 * WHY A SEPARATE MODULE FROM processes.ts (FF-7-3 / start-route-isolation.sh):
 *   src/http/processes.ts is the FROZEN display plane — it must NOT import pg or
 *   src/db/* (its GETs are pack/seed-served, with the projection merged in via the
 *   pg-carrying process-projection.ts it imports). The REAL catalog needs to read
 *   process_definition (pg, RLS) directly, so it lives here. processes.ts is left
 *   byte-untouched; the no-DB fallback (no-db-fallback.sh) that requires
 *   /api/processes to return the seed list WITHOUT DATABASE_URL stays intact.
 *
 * REAL DEFINITIONS — two honest sources, never a mock:
 *   1. choros.process_definition (074) — modeler-created drafts/published, tenant-scoped.
 *   2. process keys observed in REAL started instances (listInstanceProjections /
 *      audit-backed). The canonical ТЭЛ (telLinear) is deployed straight to Flowable
 *      from config/flowable/processes/, so it has NO process_definition row — but once
 *      a real instance is started it appears here as a REAL definition (source:
 *      'engine') derived from its own running instances. No fabricated rows: a key only
 *      appears if it has a real DB definition OR a real instance.
 *
 * GRACEFUL-EMPTY: when there are genuinely no definitions and no instances, the
 * response is { definitions: [], instances: [], bindings: [] } — an honest empty
 * state, never seed/showcase rows.
 *
 * TENANCY: resolveActorTenant(actor) (NEVER a request header/body) → withTenantTx
 * (SET LOCAL choros.tenant_id + FORCE RLS). A caller in tenant A cannot see tenant B's
 * definitions, instances, or bindings (RLS-enforced via the choros_app NOBYPASSRLS pool).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  listInstanceProjections,
  // T-0771 (E16 consistency, live-proof T-0742): the SAME single-authority
  // read-visibility predicate the /api/processes grid's ?definition=<key> deep-link
  // scopes its rows by (T-0721/T-0722/T-0723). Reused here — no bespoke copy — to
  // narrow the catalog's per-definition instance_count to what THIS actor will
  // actually see when they click the count (closes the T-0742 live-proof mismatch:
  // a card said "3 инстанса" but a non-participant's click showed 0 rows).
  filterProjectionsByReadVisibility,
  type InstanceProjection,
} from "./process-projection.js";
import {
  buildCatalogDefinitions,
  serializeInstance,
  overlayLiveSteps,
  resolveLiveNodesByInstance,
  type CatalogDefinition,
  type CatalogEnginePort,
  type CatalogInstance,
  type ProcessDefRow,
} from "../core/process-catalog-view.js";
import { selectEngineProcessNames } from "../db/engine-process-name.js";
// T-0771: type-only import (Grant/AncestryOracle) to thread the READ-visibility
// object into filterProjectionsByReadVisibility — mirrors processes.ts's identical
// import (types erase at compile; this is not the lattice math itself).
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/** Resolve an actor slug/sub to a tenant UUID (same shape as the other route modules). */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/** Injected deps. When absent the routes are NOT registered (no-DB honest degrade). */
export interface ProcessCatalogDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  /**
   * T-0709 [E16/P1]: OPTIONAL live engine. When present, each non-done instance's
   * displayed step/role is overlaid with the engine's REAL active user-task (the same
   * live source /api/processes/:inst reads) so the catalog no longer shows the NEXT
   * step's label as the CURRENT one. Absent (or unreachable per-instance) ⇒ honest
   * degrade to the audit-snapshot projection — never worse than the pre-T-0709 catalog.
   */
  flowable?: CatalogEnginePort;
  /**
   * T-0771 (E16 consistency, live-proof T-0742): OPTIONAL read-visibility resolver —
   * BYTE-IDENTICAL composition to registerProcessesRoutes'/registerRecordRoutes'
   * resolveReadVisibility (getGrantsForSubject + loadTenantOrgAncestry →
   * makeResourceAncestryOracle; single-resolver, FF-INST-VIS-2, no bespoke grant
   * query). When present, the catalog narrows its instance projections to the SAME
   * READ-visibility set the /api/processes grid's ?definition=<key> deep-link
   * applies (filterProjectionsByReadVisibility, T-0721/T-0722/T-0723) BEFORE
   * counting instances per definition — so "N инстансов" on a card equals what the
   * grid will actually show for the viewing actor, never a lying higher number.
   * Absent (no-DB / pre-wiring) ⇒ honest degrade: instance_count stays
   * tenant-scope-only, byte-identical to pre-T-0771 behaviour, never worse.
   */
  resolveReadVisibility?: (
    actorSlug: string,
    tenantId: string,
    nowMs: number,
  ) => Promise<{ readonly grants: readonly Grant[]; readonly ancestry: AncestryOracle }>;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts / agents-list.ts)
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
// extractActor — mode-aware (mirrors agents.ts::extractActor — T-0371/T-0633:
// keycloak resolves the JWT sub/preferred_username to the REAL employee slug
// via resolveActorSlugFromAuth before it drives tenant resolution). dev mode
// (x-dev-user) unchanged.
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
// Trigger type values (mirrors migration 082 CHECK constraint)
// ---------------------------------------------------------------------------

const TRIGGER_TYPES = ["on_create", "record_action", "launcher", "auto"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

function isTriggerType(v: unknown): v is TriggerType {
  return typeof v === "string" && (TRIGGER_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Binding row + serializer
// ---------------------------------------------------------------------------

interface ProcessAppBindingRow {
  id: string;
  process_key: string;
  application_id: string;
  form_key: string | null;
  // T-0351 E16: runtime trigger config columns (migration 082)
  trigger_type: string;
  start_form_key: string | null;
  field_mapping: Record<string, string> | null;
  // T-0575 (migration 119): per-(process, app) target registry override — the
  // registry_def.slug this process's step result lands in AND whose record_schema
  // the authoring floor-gate (T-0520) validates the form against. NULL = default slug.
  target_registry_slug: string | null;
  created_at: string | number;
  updated_at: string | number;
  // application display columns (LEFT JOIN — present iff the app still exists in tenant).
  app_slug: string | null;
  app_display_name: string | null;
}

export interface ProcessAppBinding {
  id: string;
  process_key: string;
  application_id: string;
  application_slug: string | null;
  application_name: string | null;
  form_key: string | null;
  // T-0351 E16: runtime trigger config
  trigger_type: TriggerType;
  start_form_key: string | null;
  field_mapping: Record<string, string>;
  // T-0575 (migration 119): per-binding target registry override (null = default).
  target_registry_slug: string | null;
  created_at: number;
  updated_at: number;
}

function serializeBinding(row: ProcessAppBindingRow): ProcessAppBinding {
  return {
    id: row.id,
    process_key: row.process_key,
    application_id: row.application_id,
    application_slug: row.app_slug,
    application_name: row.app_display_name,
    form_key: row.form_key,
    trigger_type: isTriggerType(row.trigger_type) ? row.trigger_type : "launcher",
    start_form_key: row.start_form_key,
    field_mapping:
      row.field_mapping !== null && typeof row.field_mapping === "object"
        ? (row.field_mapping as Record<string, string>)
        : {},
    // T-0575 (migration 119): surface the per-binding target registry so the UI can
    // display it and pre-fill the picker on re-bind. NULL stays null (default slug).
    target_registry_slug:
      typeof row.target_registry_slug === "string" && row.target_registry_slug.trim() !== ""
        ? row.target_registry_slug
        : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

/** Real process definitions from the modeler store (074), tenant-scoped via RLS. */
async function listProcessDefRows(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessDefRow[]> {
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT DISTINCT ON (process_key)
            process_key, name, version, status, deployment_id, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1
      ORDER BY process_key, version DESC`,
    [tenantId],
  );
  return rows;
}

/** This tenant's process↔application bindings, joined to the application for display. */
async function listBindingRows(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessAppBindingRow[]> {
  // T-0351 E16: select the 3 new runtime trigger columns (migration 082).
  // COALESCE for trigger_type/field_mapping handles rows created before 082 is applied
  // on a given environment (defensive; migrator guarantees columns exist in prod).
  const { rows } = await client.query<ProcessAppBindingRow>(
    `SELECT b.id, b.process_key, b.application_id, b.form_key,
            COALESCE(b.trigger_type, 'launcher')  AS trigger_type,
            b.start_form_key,
            COALESCE(b.field_mapping, '{}')::jsonb AS field_mapping,
            b.target_registry_slug,
            b.created_at, b.updated_at,
            a.slug         AS app_slug,
            a.display_name AS app_display_name
       FROM choros.process_app_binding b
       LEFT JOIN choros.application a
              ON a.tenant_id = b.tenant_id AND a.id = b.application_id
      WHERE b.tenant_id = $1
      ORDER BY b.created_at DESC, b.process_key ASC`,
    [tenantId],
  );
  return rows;
}

/** True iff the application exists in the caller's tenant (RLS-scoped). */
async function applicationExists(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM choros.application
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [tenantId, applicationId],
  );
  return rows.length > 0;
}

/**
 * T-0681: True iff a registry_def with this slug exists UNDER this application in the
 * caller's tenant (RLS-scoped). Guards target_registry_slug so a binding can never
 * name a registry that does not exist — that would only fail-closed later (the
 * authoring floor-gate would resolve a null live schema → 409 WRONG_FLOOR), which is
 * exactly the silent trap this task removes. Slug comes from the request body; the
 * lookup is tenant+application scoped (never a raw literal).
 */
async function registryExistsUnderApp(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
  registrySlug: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM choros.registry_def
      WHERE tenant_id = $1 AND application_id = $2 AND slug = $3
      LIMIT 1`,
    [tenantId, applicationId, registrySlug],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * T-0709-R-P2-1 (judge): shared per-request wall-clock budget for the best-effort
 * live-node overlay. A uniformly-slow-but-alive engine could otherwise stall the read
 * for tens of seconds (up to ~30s per instance × the 200-instance page). This caps the
 * WHOLE overlay: past it, the read degrades to the audit snapshot (never worse). Kept
 * short — the overlay is a display nicety, not load-bearing. Reused by the detail plane
 * (processes.ts) via the SAME resolveLiveNodesByInstance so both surfaces bound identically.
 */
export const LIVE_OVERLAY_DEADLINE_MS = 2_000;

export function registerProcessCatalogRoutes(
  router: Router,
  deps?: ProcessCatalogDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant, flowable, resolveReadVisibility } = deps;

  // -------------------------------------------------------------------------
  // GET /api/process-catalog — REAL definitions + REAL instances + bindings.
  // withAuth: keycloak → 401 without a valid Bearer JWT; dev → x-dev-user.
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/process-catalog",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);

      // Modeler definitions + bindings: one tenant-scoped tx (FORCE RLS).
      const { defRows, bindingRows } = await withTenantTx(pool, tenantId, async (client) => {
        const dr = await listProcessDefRows(client, tenantId);
        const br = await listBindingRows(client, tenantId);
        return { defRows: dr, bindingRows: br };
      });
      // Real instances: the projection module owns its own scoped tx (BYPASSRLS-safe
      // WHERE tenant_id guard, audit-backed). Real instances only — never seed/mock.
      const projections: InstanceProjection[] = await listInstanceProjections(pool, tenantId);

      // T-0771 (E16 consistency, live-proof T-0742): narrow the tenant-scoped
      // `projections` to the READ-visibility of each instance — the SAME single
      // authority (isRecordReadable for record-backed instances / isInstanceParticipant
      // for record-less ones, via filterProjectionsByReadVisibility) the /api/processes
      // grid's ?definition=<key> deep-link applies (T-0722/T-0723). Everything below —
      // the live overlay, the engine-name lookup, AND the per-definition instance_count
      // — is derived from this SAME visible set, so a card's "N инстансов" equals
      // exactly what clicking through to the grid will show. Honest-degrade (NF-2):
      // resolveReadVisibility absent (no-DB / pre-wiring) ⇒ unchanged tenant-scope-only
      // behaviour (byte-identical to pre-T-0771).
      let visibleProjections: InstanceProjection[] = projections;
      if (resolveReadVisibility) {
        const gateNowMs = Date.now();
        const { grants, ancestry } = await resolveReadVisibility(actor, tenantId, gateNowMs);
        visibleProjections = await filterProjectionsByReadVisibility(
          pool,
          tenantId,
          projections,
          grants,
          ancestry,
          gateNowMs,
          actor,
        );
      }

      // T-0709 [E16/P1]: overlay each non-done instance's LIVE active user-task
      // (step/role) from the engine — the SAME source /api/processes/:inst reads — so
      // the catalog shows the node the token is REALLY on, not the NEXT step's label
      // that the start-time process.started snapshot may have frozen in (the родитель
      // T-0349 divergence). Best-effort: no flowable, or a per-instance engine miss,
      // leaves that projection on its honest audit snapshot (overlayLiveSteps no-ops).
      // T-0771: overlays the already-visible set — a hidden instance never reaches the
      // engine layer either (mirrors the /api/processes list route's ordering).
      let displayProjections: InstanceProjection[] = visibleProjections;
      if (flowable) {
        const runningInstIds = visibleProjections
          .filter((p) => p.status !== "done")
          .map((p) => p.inst);
        if (runningInstIds.length > 0) {
          const liveByInst = await resolveLiveNodesByInstance(flowable, runningInstIds, {
            deadlineMs: LIVE_OVERLAY_DEADLINE_MS,
          });
          displayProjections = overlayLiveSteps(visibleProjections, liveByInst);
        }
      }

      // T-0732 [E16, O-1 из T-0717]: resolve human names for ENGINE-source keys
      // (observed in projections but with NO modeler defRow) from the tenant-scoped
      // engine_process_name overlay (migration 131) — the SAME middle-tier
      // resolveDefinitionNames applies on the instance/inbox plane, so the catalog's
      // engine definitions show the human name (e.g. «Канонический линейный ТЭЛ»)
      // instead of the bare key. Tenant-scoped + own explicit WHERE tenant_id (no
      // cross-tenant leak). Empty / no engine keys ⇒ no query, unchanged behaviour.
      // T-0771: keyed off visibleProjections — an engine-only definition the actor
      // cannot see any instance of carries no name/version/status of its own (it is
      // ENTIRELY derived from instances), so it honestly does not surface either
      // (consistent with the module's own "nothing is fabricated" invariant).
      const defKeys = new Set(defRows.map((d) => d.process_key));
      const engineKeys = [...new Set(visibleProjections.map((p) => p.procKey))].filter(
        (k) => !defKeys.has(k),
      );
      const engineNames =
        engineKeys.length > 0
          ? await withTenantTx(pool, tenantId, (client) =>
              selectEngineProcessNames(client, tenantId, engineKeys),
            )
          : new Map<string, string>();

      // Definitions count instances by key — unaffected by the step/role overlay, so
      // build them from visibleProjections (the READ-visibility-narrowed set, T-0771)
      // rather than the raw tenant-scoped projections: instance_count must equal what
      // the grid's deep-link shows, not the tenant-wide total.
      const definitions: CatalogDefinition[] = buildCatalogDefinitions(
        defRows,
        visibleProjections,
        engineNames,
      );
      const instances: CatalogInstance[] = displayProjections.map(serializeInstance);
      const bindings = bindingRows.map(serializeBinding);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // Honest graceful-empty: empty arrays when there is genuinely nothing real.
      res.end(JSON.stringify({ definitions, instances, bindings }));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/process-app-bindings — list this tenant's bindings (for display).
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/process-app-bindings",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);

      const rows = await withTenantTx(pool, tenantId, (client) =>
        listBindingRows(client, tenantId),
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ bindings: rows.map(serializeBinding) }));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/process-app-bindings — bind a process definition to an application.
  // Body: { process_key: string, application_id: uuid, form_key?: string|null }
  // Upsert on (tenant_id, process_key, application_id): re-binding the same pair
  // updates form_key (version-free; this is a membership link, not a contract).
  // -------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/process-app-bindings",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      const processKey = body["process_key"];
      if (typeof processKey !== "string" || processKey.trim().length === 0) {
        throw new HttpError(400, "VALIDATION", "process_key must be a non-empty string");
      }
      const applicationId = body["application_id"];
      if (typeof applicationId !== "string" || !UUID_RE.test(applicationId)) {
        throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
      }
      let formKey: string | null = null;
      if ("form_key" in body && body["form_key"] !== null && body["form_key"] !== undefined) {
        if (typeof body["form_key"] !== "string") {
          throw new HttpError(400, "VALIDATION", "form_key must be a string or null");
        }
        const fk = body["form_key"].trim();
        formKey = fk.length > 0 ? fk : null;
      }

      // T-0351 E16: runtime trigger config fields (migration 082).
      // trigger_type defaults to 'launcher' (backward-compat with old UIs that do not send it).
      let triggerType: TriggerType = "launcher";
      if ("trigger_type" in body && body["trigger_type"] !== null && body["trigger_type"] !== undefined) {
        if (!isTriggerType(body["trigger_type"])) {
          throw new HttpError(
            400,
            "VALIDATION",
            `trigger_type must be one of: ${TRIGGER_TYPES.join(", ")}`,
          );
        }
        triggerType = body["trigger_type"];
      }

      let startFormKey: string | null = null;
      if ("start_form_key" in body && body["start_form_key"] !== null && body["start_form_key"] !== undefined) {
        if (typeof body["start_form_key"] !== "string") {
          throw new HttpError(400, "VALIDATION", "start_form_key must be a string or null");
        }
        const sfk = body["start_form_key"].trim();
        startFormKey = sfk.length > 0 ? sfk : null;
      }

      let fieldMapping: Record<string, string> = {};
      if ("field_mapping" in body && body["field_mapping"] !== null && body["field_mapping"] !== undefined) {
        if (typeof body["field_mapping"] !== "object" || Array.isArray(body["field_mapping"])) {
          throw new HttpError(400, "VALIDATION", "field_mapping must be an object");
        }
        // Validate: all values must be strings (field paths → scalar only).
        const fm = body["field_mapping"] as Record<string, unknown>;
        for (const [k, v] of Object.entries(fm)) {
          if (typeof v !== "string") {
            throw new HttpError(
              400,
              "VALIDATION",
              `field_mapping["${k}"] must be a string (scalar field path)`,
            );
          }
        }
        fieldMapping = fm as Record<string, string>;
      }

      // T-0575 (migration 119): optional per-binding target registry override. NULL/empty
      // = use the default step-result slug (backward-compatible; every pre-119 row is NULL).
      // A non-empty value is validated below (inside the tenant tx) against registry_def.
      let targetRegistrySlug: string | null = null;
      if (
        "target_registry_slug" in body &&
        body["target_registry_slug"] !== null &&
        body["target_registry_slug"] !== undefined
      ) {
        if (typeof body["target_registry_slug"] !== "string") {
          throw new HttpError(400, "VALIDATION", "target_registry_slug must be a string or null");
        }
        const trs = body["target_registry_slug"].trim();
        targetRegistrySlug = trs.length > 0 ? trs : null;
      }

      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();

      const result = await withTenantTx(pool, tenantId, async (client) => {
        // Runtime integrity: the application MUST exist in the caller's tenant.
        // RLS-scoped SELECT — a cross-tenant application id reads as absent → 404.
        const exists = await applicationExists(client, tenantId, applicationId);
        if (!exists) {
          throw new HttpError(404, "NOT_FOUND", "application not found in this tenant");
        }

        // T-0681: fail-closed on an unresolvable target registry. A non-empty
        // target_registry_slug MUST name a real registry_def under THIS application in
        // THIS tenant — otherwise the binding would silently point at nothing and every
        // form save would later 409 WRONG_FLOOR (the trap T-0678/T-0680 hit). 400 here.
        if (targetRegistrySlug !== null) {
          const regOk = await registryExistsUnderApp(
            client,
            tenantId,
            applicationId,
            targetRegistrySlug,
          );
          if (!regOk) {
            throw new HttpError(
              400,
              "REGISTRY_NOT_FOUND",
              "target_registry_slug does not name a registry in this application",
            );
          }
        }

        // Upsert on the natural key (tenant_id, process_key, application_id).
        // T-0351: also upsert the 3 runtime trigger columns.
        // T-0681: also upsert target_registry_slug (migration 119).
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO choros.process_app_binding
             (tenant_id, id, process_key, application_id, form_key,
              trigger_type, start_form_key, field_mapping, target_registry_slug,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
           ON CONFLICT (tenant_id, process_key, application_id)
           DO UPDATE SET
             form_key             = EXCLUDED.form_key,
             trigger_type         = EXCLUDED.trigger_type,
             start_form_key       = EXCLUDED.start_form_key,
             field_mapping        = EXCLUDED.field_mapping,
             target_registry_slug = EXCLUDED.target_registry_slug,
             updated_at           = EXCLUDED.updated_at
           RETURNING id`,
          [
            tenantId,
            randomUUID(),
            processKey.trim(),
            applicationId,
            formKey,
            triggerType,
            startFormKey,
            JSON.stringify(fieldMapping),
            targetRegistrySlug,
            nowMs,
          ],
        );
        return rows[0]!;
      });

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: result.id,
          process_key: processKey.trim(),
          application_id: applicationId,
          form_key: formKey,
          trigger_type: triggerType,
          start_form_key: startFormKey,
          field_mapping: fieldMapping,
          target_registry_slug: targetRegistrySlug,
        }),
      );
    }),
  );
}
