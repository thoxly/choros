import * as http from "node:http";
import pg from "pg";
import { Router } from "./http/router.js";
import { JobStore, PostgresJobStore } from "./core/jobStore.js";
import { InMemoryJobStore } from "./core/inMemoryJobStore.js";
import { type Clock } from "./core/types.js";
import { PostgresTimerStore } from "./core/postgres/pgTimerStore.js";
import { PostgresOutboxStore } from "./core/postgres/pgOutboxStore.js";
import { registerExternalWorkerRoutes } from "./http/externalWorker.js";
import { registerOrgRoutes } from "./http/org.js";
import { registerInboxRoutes } from "./http/inbox.js";
import { registerFormsRoutes } from "./http/forms.js";
import { makeFormRecordPersister } from "./http/form-record-persister.js";
import { registerAuditRoutes } from "./http/audit.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerRightsRoutes } from "./http/rights.js";
import { registerDictionariesRoute, registerGrantsRoutes } from "./http/grants.js";
import { registerInvokeRoutes } from "./http/invoke.js";
import { registerGrantProposeRoute } from "./http/grant-propose.js";
import { registerSecretHandleRoutes } from "./http/secret-handle.js";
import { registerProcessesRoutes } from "./http/processes.js";
import { registerGrantTrailRoutes } from "./http/grant-trail.js";
import { registerAgentRoutes } from "./http/agents.js";
import { registerAgentListRoutes } from "./http/agents-list.js";
import { registerBindingRoutes } from "./http/binding.js";
import { registerProcessCatalogRoutes } from "./http/process-catalog.js";
import { registerArtifactRoutes } from "./http/artifacts.js";
import { registerRegistryDefRoutes } from "./http/registry-defs.js";
import { registerApplicationRoutes } from "./http/applications.js";
import { registerRecordRoutes } from "./http/records.js";
import { makeHttpKeycloakAdminPort, makeHttpKeycloakUserPort } from "./keycloak/admin-port.js";
import { registerRegisterRoutes } from "./http/register.js";
import { registerSeedWriteRoutes } from "./http/seed-write.js";
import { makeStaticHandler, resolveDefaultDistDir } from "./http/static.js";
import { type ResolverDeps } from "./core/grant-resolver.js";
import { registerNotificationPrefRoutes } from "./http/notification-prefs.js";
import { registerNotificationRoutes } from "./http/notifications.js";
import { registerEmailChannelConfigRoutes } from "./http/email-channel-config.js";
import { registerReportPageRoutes } from "./http/report-pages.js";
import { registerReportPageRenderRoutes } from "./http/report-page-render.js";
import { registerPdpExplainRoutes } from "./http/pdp-explain.js";
import { registerFloor1EditorRoutes } from "./http/floor1-editor.js";
import { registerVendorActivationRoutes } from "./http/vendor-activation.js";
import { registerRightsIntentRoutes } from "./http/rights-intents.js";
import { registerProcessDefsRoutes } from "./http/process-defs.js";
import { makeFlowableClient } from "./core/flowable-client.js";
import { getOrgPool, resolveActorTenant } from "./db/org.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Store-mode type (T-0186)
// ---------------------------------------------------------------------------

/**
 * Controls which store implementation the factory functions produce.
 *
 * - 'auto'   (default) — read DATABASE_URL from the environment; create a
 *            PostgresJobStore when the URL is present, InMemoryJobStore otherwise.
 *            This is the production path and the default for all call sites that
 *            do not pass an explicit mode.
 * - 'memory' — always return the InMemoryJobStore regardless of DATABASE_URL.
 *            Used by tests that need to pin their store implementation and must
 *            remain green whether or not an ambient DATABASE_URL is present (D-056).
 */
export type StoreMode = "auto" | "memory";

// ---------------------------------------------------------------------------
// Store factory (ADR §4.1)
// ---------------------------------------------------------------------------

/**
 * Creates a PostgresJobStore if DATABASE_URL is set, otherwise InMemoryJobStore.
 * Used by createServer() in production (index.ts) and by tests via optional store
 * injection. Clock injection seam is preserved for deterministic tests.
 *
 * Exported so startMain (src/main.ts) can call it explicitly before passing both
 * the store AND a resolverDepsObj to createServer() — required when T-0143 threads
 * ResolverDeps through the composition stack (ADR §4.3: single allocation).
 *
 * T-0186: additive optional `mode` parameter. When mode === 'memory', the function
 * always returns InMemoryJobStore regardless of DATABASE_URL. Default is 'auto'
 * (existing behaviour preserved for all callers that omit the parameter).
 */
export function createJobStore(clock?: Clock, mode?: StoreMode): PostgresJobStore | InMemoryJobStore {
  const url = mode !== "memory" ? process.env["DATABASE_URL"] : undefined;
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresJobStore(pool, clock);
  }
  return new InMemoryJobStore(clock);
}

/**
 * Creates a PostgresTimerStore if DATABASE_URL is set, otherwise undefined.
 * Timer health is only available when Postgres is configured.
 *
 * T-0186: additive optional `mode` parameter. When mode === 'memory', always
 * returns undefined (no timer store in memory mode).
 */
function createTimerStore(clock?: Clock, mode?: StoreMode): PostgresTimerStore | undefined {
  const url = mode !== "memory" ? process.env["DATABASE_URL"] : undefined;
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresTimerStore(pool, clock);
  }
  return undefined;
}

/**
 * Creates a PostgresOutboxStore if DATABASE_URL is set, otherwise undefined.
 * Outbox health (T-0062) is only available when Postgres is configured.
 *
 * T-0186: additive optional `mode` parameter. When mode === 'memory', always
 * returns undefined (no outbox store in memory mode).
 */
function createOutboxStore(clock?: Clock, mode?: StoreMode): PostgresOutboxStore | undefined {
  const url = mode !== "memory" ? process.env["DATABASE_URL"] : undefined;
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresOutboxStore(pool, clock);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal builder — composes a Router with health + external-worker routes.
// Returns both the Router (for handleRequest) and the http.Server.
// ---------------------------------------------------------------------------

function buildRouter(
  store: JobStore | PostgresJobStore | InMemoryJobStore,
  timerStore?: PostgresTimerStore,
  outboxStore?: PostgresOutboxStore,
  // T-0143: captured in closure; passed to makeGrantResolver when a route calls it.
  // Absent ⇒ hash fields drop honestly (FR-2 / NF-3).
  // Partial<ResolverDeps>: at composition-root time only keyedDigest exists;
  // per-request sources (grants/records/ancestry) are assembled at the route.
  resolverDeps?: Partial<ResolverDeps>
): Router {
  // resolverDeps is captured here in the closure so every future route that calls
  // makeGrantResolver(resolverDeps) automatically inherits the composition-root
  // binding — no second wiring step required when a new route is added (FR-3).
  void resolverDeps; // referenced via closure; used by future route registrations
  const router = new Router();
  // Postgres pool for the grant write-path (DATABASE_URL optional — routes
  // that hit DB will 500 naturally when no DB is configured; non-DB routes
  // remain available).
  const grantsPool = process.env["DATABASE_URL"]
    ? new Pool({ connectionString: process.env["DATABASE_URL"] })
    : null;

  // Register GET /health (ADR §3.7: queue + timer + outbox metrics when Postgres available)
  // T-0116: timer.timerLagMs; T-0062: outbox.{pendingLagMs,deadCount} (backward-compatible).
  router.register("GET", "/health", async (_req, res) => {
    let status: "ok" | "degraded" = "ok";
    let queueDepth = 0;
    let oldestAvailableLagMs: number | null = null;
    let workerIncidents = 0;
    let timerLagMs: number | null = null;
    let outboxPendingLagMs: number | null = null;
    let outboxDeadCount = 0;

    // Queue health (T-0114 + T-0063 workerIncidents)
    if (store instanceof PostgresJobStore) {
      try {
        const health = await store.getQueueHealth();
        queueDepth = health.depth;
        oldestAvailableLagMs = health.oldestAvailableLagMs;
        workerIncidents = health.workerIncidents;
      } catch {
        status = "degraded";
      }
    }

    // Timer health (T-0116) — independent try/catch (AC-11, ADR §3.7)
    if (timerStore !== undefined) {
      try {
        const timerHealth = await timerStore.getTimerHealth();
        timerLagMs = timerHealth.timerLagMs;
      } catch {
        status = "degraded";
      }
    }

    // Outbox health (T-0062) — independent try/catch (AC-16, ADR §4.4)
    if (outboxStore !== undefined) {
      try {
        const outboxHealth = await outboxStore.getOutboxHealth();
        outboxPendingLagMs = outboxHealth.pendingLagMs;
        outboxDeadCount = outboxHealth.deadCount;
      } catch {
        status = "degraded";
      }
    }

    const body = JSON.stringify({
      status,
      queue: {
        depth: queueDepth,
        oldestAvailableLagMs,
        workerIncidents,
      },
      timer: {
        timerLagMs,
      },
      outbox: {
        pendingLagMs: outboxPendingLagMs,
        deadCount: outboxDeadCount,
      },
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
  });

  // Register external-worker endpoints
  registerExternalWorkerRoutes(router, store as JobStore);

  // Register auth endpoints
  registerAuthRoutes(router, store as JobStore);

  // Register org structure endpoints
  registerOrgRoutes(router, store as JobStore);

  // Register inbox endpoints. T-0282 (ADR §2.3): when a pool is available
  // (DB-backed), wire the card-action approve route (POST /api/inbox/:id/action)
  // alongside the existing claim path — tenant-scoped, actor→tenant resolved from
  // the dev-user slug (the same resolver the start-route uses). Absent ⇒ read +
  // claim only (memory-mode unchanged).
  registerInboxRoutes(
    router,
    store as JobStore,
    grantsPool
      ? {
          pool: grantsPool,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
          // T-0335 (E15-S1b): thread the outbox store so the approve route's
          // step-applier can enqueue the `step_applied` row in the approve tx.
          // Absent (memory-mode) ⇒ applier seam not engaged (honest-degrade).
          outboxStore,
        }
      : undefined,
  );

  // Register form-submission endpoints (T-0102 / T-0337 E15-S4).
  // Server-side field validation is pure/in-process (no DATABASE_URL required).
  // When grantsPool is available, the real DB persist port is wired (T-0337):
  // form submit writes to choros.record in a tenant-scoped tx + audit event.
  // Without grantsPool (memory mode / tests), the in-memory RECORDS Map fallback
  // is used — the test suite passes registerFormsRoutes with no deps.
  registerFormsRoutes(
    router,
    grantsPool
      ? {
          persist: makeFormRecordPersister(
            grantsPool,
            (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
          ),
        }
      : undefined,
  );

  // Register audit endpoints
  registerAuditRoutes(router, store as JobStore);

  // Register GET /api/rights/dictionaries BEFORE :roleId catch-all (R-1 fix).
  // Seed-backed — no DATABASE_URL required (ADR §2.1 / AC-16).
  registerDictionariesRoute(router);

  // Register rights endpoints (includes GET /api/rights/:roleId catch-all).
  registerRightsRoutes(router, store as JobStore);

  // Register grant write-API (T-0030).
  // Write routes require grantsPool; pool is non-null when DATABASE_URL is set.
  if (grantsPool) {
    registerGrantsRoutes(router, grantsPool);
    // Register invoke routes (T-0024 E5.4).
    registerInvokeRoutes(router, grantsPool);
    // Register grant proposal endpoint (T-0039). Must come AFTER registerGrantsRoutes
    // so the literal '/api/grants/propose' path is not confused with ':id' patterns.
    // The path is a distinct fixed segment — it is never captured by the
    // existing '/api/grants/:id/revoke' pattern.
    registerGrantProposeRoute(router, grantsPool);
    registerSecretHandleRoutes(router, grantsPool);
    // Register seed write-API (T-0140): POST /api/tenants|departments|positions|employees|roles
    // and DELETE variants for reset. Same pool as grants.
    registerSeedWriteRoutes(router, grantsPool);
    // Register rights-INTENT operations (T-0223 D-2): hire/fire/substitute/urgent-revoke.
    // Thin orchestration over the existing kernel (grants/substitution/validateNarrowing/
    // audit). Same pool as grants. Explain-PDP-in-card reuses POST /api/pdp/explain (T-0136).
    registerRightsIntentRoutes(router, grantsPool);
  }

  // FlowableClient for engine write-paths (start-instance + process-def publish).
  // Composed here from env at call time — NO env reads in core (NF-1). Shared by
  // the processes start-route (T-0280) and process-defs publish (T-0252) so the
  // engine binding is allocated once. null when grantsPool or password is absent.
  const flowablePassword = process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
  const flowableClient =
    grantsPool && flowablePassword
      ? makeFlowableClient({
          baseUrl:
            process.env["FLOWABLE_REST_BASE_URL"] ??
            "http://flowable:8082/flowable-rest/service",
          adminUser: process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
          adminPassword: flowablePassword,
        })
      : null;

  // Register processes endpoints. The GET display plane is always registered; the
  // POST /api/processes/start write-route (T-0280, FROZEN ADR §2.2) is wired only
  // when a pool + FlowableClient are available — tenant-scoped via withTenantTx+RLS,
  // actor→tenant membership resolved from the dev-user slug (AC-9 cross-tenant deny).
  registerProcessesRoutes(
    router,
    store as JobStore,
    grantsPool && flowableClient
      ? {
          pool: grantsPool,
          flowable: flowableClient,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
        }
      : undefined,
  );

  // Register grant trail endpoints (T-0031)
  registerGrantTrailRoutes(router);

  // Register agent hire endpoint (T-0042 — additive, no existing routes modified)
  if (grantsPool) {
    const kcPort = makeHttpKeycloakAdminPort();
    registerAgentRoutes(router, grantsPool, kcPort);
    // GET /api/agents (list) + GET /api/agents/:id (T-0271 — additive, withAuth,
    // tenant-scoped via resolveActorTenant; metadata only, no secrets).
    registerAgentListRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // Register named-binding endpoints (T-0072 E11.1 — additive)
  if (grantsPool) {
    registerBindingRoutes(router, grantsPool);
  }

  // Register the REAL process catalog + process↔application binding (T-0270 E13).
  // GET /api/process-catalog (real defs from process_definition 074 + real instances
  // from the audit-backed projection), GET/POST /api/process-app-bindings. All
  // withAuth-wrapped + tenant-scoped via resolveActorTenant (same deps shape as the
  // applications/agents-list APIs). Deps-gated on grantsPool — no-DB honest degrade.
  if (grantsPool) {
    registerProcessCatalogRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // Register applications create/list/get API (T-0262 E13 — first write-surface
  // over a config primitive; the root fix for "no create buttons"). Tenant-scoped
  // via withTenantTx + RLS; the actor's tenant is resolved from the dev-user slug.
  // Siblings T-0263 (registry_def) and T-0264 (record) add their own blocks below.
  if (grantsPool) {
    registerApplicationRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // Register record create/list/get/update API (T-0264 E13 — the DATA-row write
  // surface; sibling of applications/registry_def). Records are validated against
  // their governing registry_def's record_schema, tenant-scoped via withTenantTx +
  // RLS (policy record_tenant_isolation), and create/update each write an audit
  // event (hash-chain). Same deps + tenant-resolution as applications.
  if (grantsPool) {
    registerRecordRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // Register registry_def schema-change API (T-0177 T-0121c) + create/list/get
  // (T-0263 E13). PUT/PATCH use the lazy pool (artifacts.ts pattern); the T-0263
  // create/list/get routes are deps-gated on grantsPool + resolveActorTenant (same
  // tenant-resolution as applications) and register only when grantsPool exists.
  registerRegistryDefRoutes(
    router,
    undefined,
    undefined,
    grantsPool
      ? {
          pool: grantsPool,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
        }
      : undefined,
  );

  // Register artifact tier-promote endpoint (T-0087 E12.6).
  registerArtifactRoutes(router);

  // Register notification preference endpoints (T-0171 E-N.4).
  if (grantsPool) {
    registerNotificationPrefRoutes(router, grantsPool);
  }

  // Register notification center endpoints (T-0173 E-N.6).
  if (grantsPool) {
    registerNotificationRoutes(router, grantsPool);
  }

  // Register email-channel-config endpoints (T-0203: HTTP surface over the
  // already-implemented notification-email.ts CRUD; ADR T-0120 §2.3).
  if (grantsPool) {
    registerEmailChannelConfigRoutes(router, grantsPool);
  }

  // Register PDP explain endpoint (T-0136).
  // Registered unconditionally — returns 503 NO_DATABASE when pool is absent (R-7).
  registerPdpExplainRoutes(router, grantsPool ?? null);

  // Register report_page CRUD + promote routes (T-0178 T-0121d).
  registerReportPageRoutes(router);

  // Register Floor-1 aggregate renderer + Floor-2 RLS-gated data API (T-0181 T-0121g).
  registerReportPageRenderRoutes(router);

  // Register Floor-1 form editor (T-0073 E11.2 — stateless pure transform).
  // Pool is used solely for the keycloak-mode process_designer authz lookup
  // (review R-1); dev mode works without it, so wiring stays unconditional.
  registerFloor1EditorRoutes(router, grantsPool ?? null);

  // Register vendor activation + vendor-service endpoints (T-0127 / T-0198).
  // The ONLY HTTP surface that reads activation/entitlement state. GET /vendor/activation
  // always 200 (reporting is not gating); vendor-service calls return 402/403 when the
  // subscription does not grant the service. Core/user endpoints never read the key.
  registerVendorActivationRoutes(router);

  // Register process-definition CRUD + publish routes (T-0252 E8 C2).
  // Requires grantsPool (same tenant RLS pattern) + the shared FlowableClient
  // composed above from env (NO env reads in core — NF-1).
  if (grantsPool && flowableClient) {
    registerProcessDefsRoutes(router, grantsPool, flowableClient);
  }

  // T-0342: Register public registration endpoint (POST /api/register).
  // Deps-gated on grantsPool (DB required to create the new tenant). KC registrar
  // config is read from env (KC_REGISTRAR_CLIENT_ID + KC_REGISTRAR_CLIENT_SECRET);
  // if absent, endpoint returns 503 AUTH_UNAVAILABLE (honest-degrade per ADR §8 step 4).
  // Do NOT wrap in withAuth — this is a PRE-LOGIN public endpoint (FF-1).
  if (grantsPool) {
    const registrarClientSecret = process.env["KC_REGISTRAR_CLIENT_SECRET"];
    const kcUserPort = registrarClientSecret
      ? makeHttpKeycloakUserPort()
      : // No registrar secret configured: port always returns AUTH_UNAVAILABLE (honest-degrade)
        {
          async createHumanUser(): Promise<{ userId: string }> {
            const err = new Error("AUTH_UNAVAILABLE");
            (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
            throw err;
          },
          async deleteUser(): Promise<void> {
            /* no-op compensation */
          },
        };
    registerRegisterRoutes(router, { pool: grantsPool, kc: kcUserPort });
  }

  // Set static file handler as fallback for everything else
  router.setFallback(makeStaticHandler(resolveDefaultDistDir()));

  return router;
}

/**
 * Factory: creates an http.Server with a fresh Router and the provided JobStore.
 * The optional `store` parameter allows test suites to inject a stub-clock store
 * for deterministic lock-expiry testing. Zero-arg usage (index.ts, health.test.ts)
 * is preserved via the default parameter.
 *
 * T-0143: additive optional second parameter `resolverDeps?: ResolverDeps`.
 * When present it is threaded to `buildRouter` where it is captured in a closure
 * for use by any route that calls `makeGrantResolver` (FR-3, NF-2 / FE-W23-0008).
 * Zero-arg and one-arg callers are unaffected (additive optional parameter).
 * When absent, `hash` fields drop honestly (FR-2 / NF-3).
 *
 * T-0186: additive optional third parameter `storeMode?: StoreMode`. When
 * `storeMode === 'memory'`, forces all store factories (job/timer/outbox) to
 * return in-memory implementations regardless of DATABASE_URL. Tests that need
 * to remain green under ambient DATABASE_URL pass 'memory' here. Production
 * callers that omit the parameter get the default 'auto' behaviour (env-based
 * store selection preserved). When an explicit `store` is already provided as the
 * first argument, `storeMode` only affects the timer and outbox stores.
 *
 * Does NOT call .listen() — that is the caller's responsibility.
 */
export function createServer(
  store?: JobStore | PostgresJobStore | InMemoryJobStore,
  // Partial<ResolverDeps>: at composition-root time only keyedDigest is available;
  // per-request sources (grants/records/ancestry) are assembled at the route (T-0143 §4.3 amendment).
  // Absent => hash fields drop honestly (FR-2 / NF-3).
  resolverDeps?: Partial<ResolverDeps>,
  // T-0186: explicit store mode; 'memory' pins to InMemoryJobStore regardless of DATABASE_URL.
  storeMode?: StoreMode
): http.Server {
  const resolvedStore = store ?? createJobStore(undefined, storeMode);
  const router = buildRouter(resolvedStore, createTimerStore(undefined, storeMode), createOutboxStore(undefined, storeMode), resolverDeps);
  return http.createServer(router.dispatch.bind(router));
}

/**
 * Named export preserved for backwards-compatibility with health.test.ts, which
 * imports and calls `handleRequest` directly rather than going through createServer.
 *
 * Backed by a lazy-built default-store router so that GET /health (and the
 * external-worker routes) behave identically to what createServer() would produce.
 * Lazy evaluation ensures environment variables (e.g., CHOROS_WEB_DIST) set by
 * test harnesses are respected.
 *
 * T-0186: additive optional third parameter `storeMode?: StoreMode`. Routers are
 * cached separately per mode so that a 'memory'-mode call and a subsequent
 * 'auto'-mode call each get their own valid cached router without
 * cross-contamination. Tests pin 'memory' to remain green under ambient
 * DATABASE_URL; production callers omit the parameter (default 'auto' path).
 */
const _routerCache: Partial<Record<StoreMode, Router>> = {};

export const handleRequest = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeMode?: StoreMode
): void => {
  const mode: StoreMode = storeMode ?? "auto";
  if (!_routerCache[mode]) {
    _routerCache[mode] = buildRouter(createJobStore(undefined, mode), createTimerStore(undefined, mode), createOutboxStore(undefined, mode));
  }
  _routerCache[mode]!.dispatch(req, res);
};
