/**
 * src/http/rights-resources.ts — T-0609
 *
 * GET /api/rights/resources — the tenant's REAL resource dictionary (applications +
 * registries), for the «Дать роли право» grant form's resource selector
 * (web/src/screens/rights/ra-overview-forms.jsx GrantRightForm).
 *
 * WHY THIS FILE EXISTS (not a change to src/http/grants.ts): GET /api/rights/dictionaries
 * (grants.ts:683-698, registerDictionariesRoute) serves a hardcoded 10-entry demo
 * resource list (DICT_RESOURCES) — legitimate for a demo tenant, but the ONLY option
 * a real tenant's admin ever sees, so a right can never be granted on that tenant's
 * own applications/registries ("Заявка на закупку", "Поставщик", etc. — live
 * acceptance finding, 2026-07-03). src/http/grants.ts is byte-frozen
 * (ci/checks/rights-ui-frozen-write.sh, T-0572 FF-T0572-FROZEN) — this task cannot
 * edit it. This is therefore a NEW, additive read-only endpoint; the web layer
 * merges its result with the existing /api/rights/dictionaries response (see
 * screen-rights.jsx fetchRealResources()) rather than one endpoint replacing the
 * other.
 *
 * RESOURCE-IDENTIFIER FORMAT (ADR-T0609 §1.3 — do NOT invent a second format):
 * `resource_type` (the column a grant's POST body carries) is, in the EXISTING
 * GrantRightForm/DICT_PRESETS pattern this form belongs to, a free-form NAMING
 * string (e.g. "mcp://ledger.invoices") — never parsed as a URL/scheme anywhere in
 * this codebase, purely a stable opaque label. This endpoint mints values in the
 * SAME class of string: "registry:<application_slug>" for an application-level
 * resource, "registry:<application_slug>.<registry_slug>" for a specific registry —
 * slugs (not UUIDs) so the value stays human-readable in the same places
 * mcp://-style values already appear (grant-trail, audit). This is DELIBERATELY
 * NOT the T-0570 READ-PDP resource-hierarchy format (resource_type='registry' +
 * scope.nodeId=uuid) — that format serves a different grant pattern; switching
 * GrantRightForm over to it is a separate, larger refactor (ADR §1.3, follow-up O2).
 *
 * TENANT SCOPING: reuses the EXISTING listApplications (src/http/applications.ts)
 * and listRegistryDefs (src/http/registry-defs.ts) DAOs verbatim — both already
 * RLS-scoped via withTenantTx(pool, tenantId, ...). No new SQL, no new table.
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { type Router } from "./router.js";
import { HttpError } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { listApplications, type ApplicationRow } from "./applications.js";
import { listRegistryDefs, type RegistryDefCrudRow } from "./registry-defs.js";

// ---------------------------------------------------------------------------
// Injected deps (mirrors ApplicationRoutesDeps in applications.ts)
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface RightsResourcesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Actor extraction — mirrors the identical private helper in applications.ts /
// registry-defs.ts (each HTTP file owns its own copy; project convention, not
// shared to avoid a cross-file coupling for a three-line identity read).
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
// Resource-shape mapping — application/registry_def rows → {uri, name} the
// grant form already renders (ra-overview-forms.jsx GrantRightForm: 'resources.map(r
// => ({value:r.uri,label:r.name}))' — this shape is NOT new, DICT_RESOURCES carries
// exactly the same two fields).
// ---------------------------------------------------------------------------

export interface RightsResource {
  uri: string;
  name: string;
  /**
   * T-0609 F-1 fix: the row's real UUID — the grant's scope nodeId. The PDP
   * covering predicate (grant-resolver.ts resolveFor / read-visibility.ts
   * isRecordReadable) matches a grant by SCOPE containment over the resource
   * hierarchy (isNarrowerOrEqual(handleScope, g.scope)) and never reads
   * resource_type — so for a grant produced by the «Дать роли право» form to
   * actually resolve, its scope must be {kind:'node', hierarchy:'resource',
   * nodeId:<this id>, nodeLevel:<node_level below>} — the SAME shape refToScope
   * emits for runtime requests and the composite resource-ancestry oracle
   * (src/db/resource-ancestry.ts rules 1/3) covers. The form builds that scope
   * from these two fields; uri stays the human-stable display label carried in
   * resource_type.
   */
  id: string;
  /** Resource-hierarchy node level `id` lives at — the grant's scope nodeLevel. */
  node_level: "application" | "registry";
}

/** Build the application-level resource entry: "registry:<slug>". */
function applicationResource(app: ApplicationRow): RightsResource {
  return {
    uri: `registry:${app.slug}`,
    name: app.display_name,
    id: app.id,
    node_level: "application",
  };
}

/**
 * Build a registry-level resource entry: "registry:<app_slug>.<registry_slug>".
 * `appSlug` falls back to the application's id when the owning application row
 * is not present in `appById` (should not happen under RLS — both queries share
 * the same tenant scope — but the read stays honest rather than throwing on a
 * data race between the two queries).
 */
function registryResource(
  reg: RegistryDefCrudRow,
  appById: Map<string, ApplicationRow>,
): RightsResource {
  const app = appById.get(reg.application_id);
  const appSlug = app ? app.slug : reg.application_id;
  const name = app ? `${app.display_name} · ${reg.display_name}` : reg.display_name;
  return {
    uri: `registry:${appSlug}.${reg.slug}`,
    name,
    id: reg.id,
    node_level: "registry",
  };
}

/**
 * Build the tenant's real resource list from its application + registry_def rows.
 * Exported (pure mapping over already-fetched rows) so it is unit-testable without
 * a live pool.
 */
export function buildRightsResources(
  apps: ApplicationRow[],
  regs: RegistryDefCrudRow[],
): RightsResource[] {
  const appById = new Map(apps.map((a) => [a.id, a]));
  return [
    ...apps.map(applicationResource),
    ...regs.map((r) => registryResource(r, appById)),
  ];
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers GET /api/rights/resources. Only wired when a pool + tenant resolver
 * are available (DB-backed mode) — mirrors registerApplicationRoutes' honest
 * no-DB degrade (the route is simply absent rather than 503-ing on every call).
 */
export function registerRightsResourcesRoute(
  router: Router,
  deps: RightsResourcesDeps,
): void {
  const { pool, resolveActorTenant } = deps;

  router.register("GET", "/api/rights/resources", withAuth(async (req, res) => {
    const actorSlug = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actorSlug);

    const apps = await listApplications(pool, tenantId);
    const regs = await listRegistryDefs(pool, tenantId, null);
    const resources = buildRightsResources(apps, regs);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ resources }));
  }));
}
