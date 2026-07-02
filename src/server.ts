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
import { registerMessageIngestRoutes, emitInternalSignal } from "./http/message-ingest.js";
import { RECORD_STATUS_SIGNAL } from "./http/records.js";
import { registerFormsRoutes } from "./http/forms.js";
import { makeFormRecordPersister, makeFormDefResolver } from "./http/form-record-persister.js";
import { registerAuditRoutes } from "./http/audit.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerRightsRoutes } from "./http/rights.js";
import { registerDictionariesRoute, registerGrantsRoutes } from "./http/grants.js";
import { registerInvokeRoutes } from "./http/invoke.js";
import { registerGrantProposeRoute, defaultGrantProposeDeps } from "./http/grant-propose.js";
import { registerSecretHandleRoutes } from "./http/secret-handle.js";
import { actorInjectRegistrar } from "./http/actor-inject-registrar.js";
import { registerProcessesRoutes } from "./http/processes.js";
import { registerGrantTrailRoutes } from "./http/grant-trail.js";
import { registerAgentRoutes } from "./http/agents.js";
import { registerAgentListRoutes } from "./http/agents-list.js";
import { registerBindingRoutes } from "./http/binding.js";
import { registerProcessCatalogRoutes } from "./http/process-catalog.js";
import { registerArtifactRoutes } from "./http/artifacts.js";
import { registerRegistryDefRoutes } from "./http/registry-defs.js";
import { registerApplicationRoutes } from "./http/applications.js";
import { registerSolutionPublishRoutes } from "./http/solution-publish.js";
import { registerSectionRoutes } from "./http/sections.js";
import { registerRecordRoutes } from "./http/records.js";
import { registerRecordLinksRoutes } from "./http/record-links.js";
import { registerAssistantRoutes } from "./http/assistant.js";
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
import { registerDmnRuleTableRoutes } from "./http/dmn-rule-table.js";
import { registerVendorActivationRoutes } from "./http/vendor-activation.js";
import { registerRightsIntentRoutes } from "./http/rights-intents.js";
import { registerRightsChangeRequestRoutes } from "./http/rights-change-requests.js";
import { registerSodRoutes } from "./http/rights-sod.js";
import { registerSodAdminRoutes } from "./http/rights-sod-admin.js";
import { registerProcessDefsRoutes } from "./http/process-defs.js";
import { registerSolutionBundleRoutes } from "./http/solution-bundles.js";
import { makeFlowableClient } from "./core/flowable-client.js";
import { getOrgPool, resolveActorTenant, resolveActorSlugFromAuth } from "./db/org.js";
// T-0419 (D7-3-FU): production field-visibility resolver — grants + policy from DB.
import { getGrantsForSubject, getFieldVisibilityPolicy } from "./db/grants-dao.js";
import { dormantLlmPort } from "./core/llm-port.js";
// T-0363 (E17): DeepSeek / OpenAI-compatible LLM adapter (composition-root only — RL-3).
import { OpenAILlmPort } from "./adapters/openai-llm-port.js";
import { validateSecretHandleShape, redactHandle, parseAppHandle, type SecretResolverPort } from "./core/secret-handle-validator.js";
// T-0382 (D5) BLOCKER-1: env:// secret-handle allow-list (arbitrary env exfil guard).
import { decideEnvHandle } from "./core/env-secret-allowlist.js";
// T-0476 (E-AGENTS L3): app:// encrypted secret store — AEAD decrypt at the root.
import { loadMasterKey, decryptSecret, AppSecretStoreUnconfiguredError } from "./core/app-secret-cipher.js";
import { getAppSecretSealed } from "./db/app-secret-dao.js";
import { registerAppSecretRoutes } from "./http/app-secret.js";
// T-0496: "Проверить подключение" — server-side LLM connection probe.
import { registerLlmConnectionTestRoute } from "./http/llm-connection-test.js";
import { type PgClientLike } from "./db/audit-writer.js";
// T-0363 (E17): Analyst production ports.
import { setAnalystPorts } from "./core/assistant-analyst.js";
import { loadCycleTimeByActivity, loadActorTypeBreakdown } from "./db/transition-journal.js";
// T-0382 (D5): per-tenant LLM config (BYO) — read from agent_card at call time.
import { loadTenantLlmConfig } from "./db/agent-card-llm.js";
// T-0382: LLM-config HTTP routes (tenant LLM connection screen backend).
import { registerLlmConfigRoutes } from "./http/llm-config.js";
import { registerLlmConnectionsRoutes } from "./http/llm-connections.js";
// T-0383 (D5/PD-6): per-tenant assistant system prompt routes + runtime loader.
import { registerAssistantPromptRoutes } from "./http/assistant-prompt-routes.js";
import { readPublishedAssistantPrompt } from "./db/assistant-prompt-dao.js";
// T-0477 [E-AGENTS L5]: spend accounting routes + spend-tracking LLM port.
import { registerSpendRoutes } from "./http/spend.js";
// T-0405 [PD-20]: operational analytics routes (GROUP BY on index, xlsx export).
import { registerOperationalAnalyticsRoutes } from "./http/operational-analytics.js";
import { getDefaultLlmConnection } from "./db/llm-connection-dao.js";
// T-0518: file attachment HTTP routes + adapters.
import { registerFileRoutes } from "./http/files.js";
import { PgFileStore } from "./core/postgres/pgFileStore.js";
import { FsObjectStore } from "./adapters/s3-object-store.js";
import { makeFileRecordResolver } from "./core/grant-resolver.js";
import { makeDbGrantSource } from "./db/grants-dao.js";
import { SEED_ORACLE } from "./http/seed-ancestry.js";
// T-0570 (D3, READ-PDP): production wiring for the records READ-PDP gate —
// same getGrantsForSubject DAO (single-resolver) + composite resource-ancestry
// oracle (org delegate + resource root-sentinel/inline-chain).
import { loadTenantOrgAncestry } from "./db/org-ancestry.js";
import { makeResourceAncestryOracle } from "./db/resource-ancestry.js";
import type { RowAncestry } from "./core/read-visibility.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// T-0363 (E17): DeepSeek / OpenAI-compatible LLM composition root.
//
// Read from process.env ONCE at module-evaluation time.
// No secret value is logged or committed — only the opaque handle reference.
// RL-3: the raw key is never stored raw; the env-backed SecretResolverPort
//   reads it at call-time from process.env so it is never captured in a closure.
// The secretHandle "env://DEEPSEEK_API_KEY" passes validateSecretHandleShape:
//   - length ≥ 8 ✓  - not a vendor prefix ✓  - not bare hex ✓  - not JWT ✓
// ---------------------------------------------------------------------------

const DEEPSEEK_API_KEY   = process.env["DEEPSEEK_API_KEY"];
const DEEPSEEK_BASE_URL  = process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com";
const DEEPSEEK_MODEL     = process.env["DEEPSEEK_MODEL"]    ?? "deepseek-chat";

/**
 * Opaque handle for the DeepSeek API key.
 * The handle is an env-reference string — NOT a raw key.
 * It passes validateSecretHandleShape (env:// prefix, length > 8, no vendor prefix).
 */
const DEEPSEEK_HANDLE = "env://DEEPSEEK_API_KEY";

// Validate at startup so misconfiguration fails loudly rather than at first request.
const _handleVerdict = validateSecretHandleShape(DEEPSEEK_HANDLE);
if (!_handleVerdict.ok) {
  // This is a programming error — the handle constant above must be corrected.
  throw new Error(
    `[T-0363] Invalid DeepSeek secret handle (${_handleVerdict.reason}): ` +
    `handle (redacted): ${redactHandle(DEEPSEEK_HANDLE)}`,
  );
}

/**
 * Env-backed SecretResolverPort for DeepSeek.
 * Reads the raw key from process.env at CALL TIME only — never stored in a closure.
 * RL-3: the resolver is the ONLY place that touches the raw key.
 * Stage-deploy invariant: this object is created in src/server.ts (composition root),
 * NOT in src/core/** or src/adapters/** (stage-deploy boundary intact).
 */
const deepseekSecretResolver: SecretResolverPort = {
  async resolveSecret(handle: string, _ctx: { tenantId: string }): Promise<string> {
    if (handle === DEEPSEEK_HANDLE) {
      const key = process.env["DEEPSEEK_API_KEY"];
      if (!key) {
        throw new Error(`[T-0363] DeepSeek API key not found in environment (handle: ${redactHandle(handle)})`);
      }
      return key;
    }
    throw new Error(`[T-0363] Unknown secret handle: ${redactHandle(handle)}`);
  },
};

/**
 * T-0413 (SECURITY-FU): tenant-facing secret resolver.
 *
 * SECURITY: the `env://` scheme is SYSTEM-ONLY and MUST NOT be resolvable from a
 * tenant-supplied handle. A tenant admin controls BOTH the secret-handle stored in
 * agent_card AND the llm_endpoint (PUT /api/llm-config). If a tenant could supply
 * an env:// handle (even the allow-listed DEEPSEEK_API_KEY), they could point the
 * endpoint at an attacker host and have the server ship the SHARED system key as a
 * Bearer token — exfiltrating a credential shared across all tenants.
 *
 * Therefore `env://` handles are NEVER resolvable through the tenant path,
 * regardless of which var name they reference. Tenant BYO keys MUST be stored
 * through the encrypted secret-handle custody store (POST /api/agents/:id/secret-handle,
 * T-0025) and resolved through that path only.
 *
 * The system env fallback (DEEPSEEK_API_KEY when no tenant config exists) is wired
 * separately in makeLlmPortFactory via deepseekSecretResolver — that path is NOT
 * reachable by a tenant-supplied handle.
 */
// Exported for adversarial testing (T-0413): a test can call
// resolveSecret("env://...") against the REAL composition-root resolver
// and assert it always throws rather than returning any server env value.
export const tenantSecretResolver: SecretResolverPort = {
  async resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string> {
    // T-0476 (E-AGENTS L3): app://<id> → decrypt the tenant's BYO key IN MEMORY.
    // This is the self-serve tenant key path. The plaintext is returned ONLY to the
    // immediate caller (the LLM adapter at call time) — it is NEVER logged, returned
    // in an API response, or egressed (the secret-handle-isolation gate enforces no
    // raw-key handling outside this custody resolver).
    const appRef = parseAppHandle(handle);
    if (appRef !== null) {
      // Master key from env at the COMPOSITION ROOT only (app-secret-cipher is env-free).
      let masterKey: Buffer;
      try {
        masterKey = loadMasterKey(process.env["APP_SECRET_MASTER_KEY"]);
      } catch (err) {
        if (err instanceof AppSecretStoreUnconfiguredError) {
          // DORMANT: store not configured → honest error (no crash, no plaintext).
          throw new Error(
            `[T-0476] app:// secret store is not configured (APP_SECRET_MASTER_KEY unset); ` +
            `cannot resolve handle ${redactHandle(handle)}.`,
          );
        }
        throw err;
      }
      // Read the sealed row under the tenant's RLS scope, then decrypt in memory.
      const pool = getOrgPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL choros.tenant_id = '${ctx.tenantId}'`);
        await client.query("SET LOCAL search_path TO choros");
        const sealed = await getAppSecretSealed(
          client as unknown as PgClientLike,
          ctx.tenantId,
          appRef.secretId,
        );
        await client.query("COMMIT");
        if (sealed === null) {
          // Not found / wrong tenant (RLS hid it) → opaque error, no key material.
          throw new Error(`[T-0476] app:// secret not found for handle ${redactHandle(handle)}`);
        }
        // Decrypt IN MEMORY. Returned to the immediate caller ONLY (RL-3).
        return decryptSecret(
          { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyVersion: sealed.keyVersion },
          masterKey,
        );
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* already closed */ }
        throw err;
      } finally {
        client.release();
      }
    }

    // T-0413: REJECT all env:// handles in the tenant path — scheme is SYSTEM-ONLY.
    // decideEnvHandle classifies the handle; any env:// outcome (denied OR allowed)
    // is rejected here because the allow-list only governs the system-internal path.
    const decision = decideEnvHandle(handle);
    if (decision.kind !== "not_env") {
      // env:// handle from a tenant-supplied source → always reject.
      // The redactHandle strips the var name to avoid leaking it via the error message.
      throw new Error(
        `[T-0413] env:// handles are system-only and may not be used as tenant secret ` +
        `handles (handle: ${redactHandle(handle)}). Store tenant keys via the ` +
        `secret-handle custody store (POST /api/agents/:id/secret-handle).`,
      );
    }
    // Other handle shapes (vault://, opaque tokens, etc.) are not resolvable at
    // the env layer — return a descriptive error so the dormant path activates.
    throw new Error(
      `[T-0413] Cannot resolve handle scheme at env layer: ${redactHandle(handle)}. ` +
      `Use the secret-handle custody store or wire a vault resolver.`,
    );
  },
};

/**
 * T-0382 (D5): per-tenant LLM port factory (async).
 *
 * Priority order:
 *   1. Per-tenant agent_card config (all three llm_* fields non-null AND handle valid).
 *   2. Global env fallback (DEEPSEEK_API_KEY — backward-compatible T-0363 path).
 *   3. dormantLlmPort → 503 (fail-closed default).
 *
 * Each call queries the DB fresh so live config changes are picked up without
 * a restart (no caching — the per-message latency hit is a single indexed
 * SELECT on a small table; acceptable per PD-5).
 *
 * Called only from buildRouter's assistant route wiring and llm-config route —
 * both in src/server.ts (composition root). NOT called from core or adapters.
 */
async function makeLlmPortFactory(
  tenantId: string,
  grantsPool: pg.Pool | null,
) {
  // 1. Attempt per-tenant DB config.
  const tenantCfg = await loadTenantLlmConfig(grantsPool, tenantId);
  if (tenantCfg) {
    // TenantLlmConfig.secretHandle is the aliased opaque handle (RL-3: not raw key).
    const verdict = validateSecretHandleShape(tenantCfg.secretHandle);
    if (verdict.ok) {
      return new OpenAILlmPort({
        endpoint:     tenantCfg.llmEndpoint,
        model:        tenantCfg.llmModel,
        secretHandle: tenantCfg.secretHandle,
        tenantId,
        secretResolver: tenantSecretResolver,
      });
    }
    // Invalid handle shape in DB → fall through to env fallback (log but don't crash).
  }

  // 2. Global env fallback (T-0363 backward-compatible path).
  if (DEEPSEEK_API_KEY) {
    return new OpenAILlmPort({
      endpoint: DEEPSEEK_BASE_URL,
      model:    DEEPSEEK_MODEL,
      secretHandle: DEEPSEEK_HANDLE,
      tenantId,
      secretResolver: deepseekSecretResolver,
    });
  }

  // 3. No config → dormant (fail-closed, three-lock §6).
  return dormantLlmPort;
}

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

  // T-0443: FlowableClient must be created BEFORE registerInboxRoutes so it can be
  // threaded into inbox deps (additive-optional; honest-degrade when absent).
  // Also used by registerProcessesRoutes below (start-instance + process-def publish).
  // Moved earlier than original position; functionally identical (same env reads).
  const flowablePassword = process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
  const flowableClient =
    grantsPool && flowablePassword
      ? makeFlowableClient({
          baseUrl:
            process.env["FLOWABLE_REST_BASE_URL"] ??
            // T-0483: compose-internal hostname `flowable` is reachable on the
            // container-internal port 8080 (8082 is the host-published mapping only,
            // invalid from inside the compose network). Keep the default self-consistent
            // so an absent override does not silently produce ENGINE_UNAVAILABLE.
            "http://flowable:8080/flowable-rest/service",
          adminUser: process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
          adminPassword: flowablePassword,
        })
      : null;

  // T-0483: engine readiness probe. Separate from GET /health (which is the
  // CONTAINER liveness probe — it must NOT depend on the engine, or an engine
  // blip would mark choros itself unhealthy and trigger a needless restart).
  // This endpoint reflects engine reachability so the UI / ops can distinguish
  // "engine down" (honest "движок недоступен") from "app down". When no client is
  // configured (memory mode / no FLOWABLE creds) it reports status "unknown".
  router.register("GET", "/api/engine/health", async (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!flowableClient || typeof flowableClient.pingEngine !== "function") {
      res.statusCode = 200;
      res.end(JSON.stringify({ engine: "unknown", reason: "not_configured" }));
      return;
    }
    try {
      const ping = await flowableClient.pingEngine();
      if (ping.reachable) {
        res.statusCode = 200;
        res.end(JSON.stringify({ engine: "up" }));
      } else {
        // 503 so callers (and the UI) see a clear "engine unavailable" signal.
        res.statusCode = 503;
        res.end(JSON.stringify({ engine: "down", code: ping.code }));
      }
    } catch {
      // pingEngine never throws, but be defensive: report down rather than 500.
      res.statusCode = 503;
      res.end(JSON.stringify({ engine: "down", code: "ENGINE_UNAVAILABLE" }));
    }
  });

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
          // T-0443: optional FlowableClient for engine-drive post-approve (defKey resolution
          // + reconcile). Absent ⇒ linear audit-only behaviour unchanged (honest-degrade).
          flowableClient: flowableClient ?? undefined,
        }
      : undefined,
  );

  // T-0536 [D8-R4 delivery]: register the MESSAGE INGEST door (POST /api/message)
  // — the producer that finally feeds deliverMessageEnvelope so a process parked on
  // a message-catch can RECEIVE its message and continue. Only when a DB pool + a
  // live engine are present (honest-degrade: no delivery path without both). Tenant
  // is taken from the ACTOR'S identity (resolveActorTenant), never from the body —
  // cross-tenant correlation is structurally impossible (tenant-fail-closed).
  registerMessageIngestRoutes(
    router,
    grantsPool && flowableClient
      ? {
          pool: grantsPool,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
          engine: flowableClient,
        }
      : undefined,
  );

  // Register form-submission endpoints (T-0102 / T-0337 E15-S4 / T-0345).
  // T-0345: when grantsPool is available, the FormDefResolver port is wired so
  //   the route handler derives the active FormDef from the registry's record_schema
  //   (single source of truth — registry governs what fields are accepted).
  // Without grantsPool (memory mode / tests), the no-op memoryPersist fallback
  // is used — mints a UUID for the response contract but no authoritative Map
  // (T-0336 doctrine §3.3). Tests pass registerFormsRoutes with no deps.
  registerFormsRoutes(
    router,
    grantsPool
      ? {
          persist: makeFormRecordPersister(
            grantsPool,
            (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
          ),
          resolveFormDef: makeFormDefResolver(
            grantsPool,
            (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
          ),
        }
      : undefined,
  );

  // Register audit endpoints.
  // T-0500: GET /api/audit now reads the REAL tenant-wide audit log — thread the
  // grants pool (null in memory mode → the route fails honestly with 503). The
  // demo instance-trace routes (/api/audit/:id, /api/audit/export) are pool-free.
  registerAuditRoutes(router, store as JobStore, grantsPool ?? undefined);

  // Register GET /api/rights/dictionaries BEFORE :roleId catch-all (R-1 fix).
  // Seed-backed — no DATABASE_URL required (ADR §2.1 / AC-16).
  registerDictionariesRoute(router);

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
    // T-0489 [SECURITY]: keycloak-aware identity + tenant from the actor's own row
    // (resolveActorTenant, fail-closed) instead of the hardcoded Dev Silo. Identity
    // is resolved inside the handler via getAuthContext → resolveActorSlugFromAuth.
    registerGrantProposeRoute(router, grantsPool, {
      ...defaultGrantProposeDeps,
      resolveActorTenant: (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
    });
    // T-0418 [SECURITY] P0 + T-0328 G1: secret-handle.ts is FROZEN — its body still
    // resolves identity via the dev-only x-dev-user extractActor. Wrap at the
    // REGISTRATION SITE with the actor-inject façade (superset of withAuthRegistrar):
    // it applies withAuth() (keycloak ⇒ valid Bearer REQUIRED; 401 otherwise, x-dev-user
    // no longer bypasses) AND, in keycloak mode, resolves the validated JWT identity
    // (getAuthContext → resolveActorSlugFromAuth, kind='human' only) into x-dev-user
    // BEFORE the frozen body reads it — so the surface is FUNCTIONAL with a real Bearer,
    // not just 401-closed (ADR T-0328 §4.1 G1; unblocks T-0471). Dev mode is a pure
    // pass-through. secret-handle.ts is byte-untouched. (Tenant stays DEV_TENANT_ID
    // in-body — secret-handle does not read x-tenant-id — so no injectTenant here.)
    registerSecretHandleRoutes(
      actorInjectRegistrar(router, {
        resolveActorSlug: (sub, preferredUsername) =>
          resolveActorSlugFromAuth(getOrgPool(), sub, preferredUsername),
      }) as unknown as typeof router,
      grantsPool,
    );
    // Register seed write-API (T-0140): POST /api/tenants|departments|positions|employees|roles
    // and DELETE variants for reset. Same pool as grants.
    registerSeedWriteRoutes(router, grantsPool);
    // Register rights-INTENT operations (T-0223 D-2): hire/fire/substitute/urgent-revoke.
    // Thin orchestration over the existing kernel (grants/substitution/validateNarrowing/
    // audit). Same pool as grants. Explain-PDP-in-card reuses POST /api/pdp/explain (T-0136).
    // T-0489 [SECURITY]: keycloak-aware identity + tenant from the actor's own row
    // (resolveActorTenant, fail-closed). All four intent ops (hire/fire/substitute/
    // urgent-revoke) now run under the caller's REAL tenant, not the Dev Silo.
    registerRightsIntentRoutes(router, grantsPool, (actorSlug: string) =>
      resolveActorTenant(getOrgPool(), actorSlug),
    );
    // Register dual-control change-request API (T-0390 D2-FU).
    // MUST be registered BEFORE registerRightsRoutes (which adds GET /api/rights/:roleId).
    // The router is first-match-wins; without this ordering the static path
    // /api/rights/change-requests would be swallowed by the :roleId param route,
    // calling findRole("change-requests") and returning 404 on every list request.
    registerRightsChangeRequestRoutes(router, grantsPool);
    // Register SoD read API (T-0391 D2-FU).
    // MUST be registered BEFORE registerRightsRoutes (which adds GET /api/rights/:roleId).
    // /api/rights/sod-rules and /api/rights/sod-check are literal paths and would
    // otherwise be captured by the :roleId param slot (first-match-wins).
    registerSodRoutes(router, grantsPool);
    // Register SoD write API (T-0386 D6): CRUD for sod_constraint rows.
    // Must also precede registerRightsRoutes (/api/rights/:roleId catch-all).
    // PUT/DELETE /api/rights/sod-rules/:id are distinct paths from the literal
    // GET /api/rights/sod-rules registered by registerSodRoutes above.
    registerSodAdminRoutes(router, grantsPool);
  }

  // Register rights endpoints (includes GET /api/rights/:roleId catch-all).
  // Registered AFTER registerRightsChangeRequestRoutes + registerSodRoutes so all
  // static literal paths under /api/rights/* are already bound and first-match-wins
  // routing never reaches the :roleId parameter slot for those paths.
  registerRightsRoutes(router, store as JobStore);

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
    // T-0328 G1: actor-slug resolver (kind='human') for the actor-inject façade so the
    // FROZEN process-start body receives the validated JWT identity (x-dev-user +
    // x-tenant-id) in keycloak mode. Wired only when DB-backed (grantsPool present).
    grantsPool
      ? (sub: string, preferredUsername: string | undefined) =>
          resolveActorSlugFromAuth(getOrgPool(), sub, preferredUsername)
      : undefined,
  );

  // Register grant trail endpoints (T-0031 / T-0514: real tenant via resolveActorTenant).
  registerGrantTrailRoutes(
    router,
    grantsPool
      ? {
          pool: grantsPool,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
        }
      : undefined,
  );

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

  // Register named-binding endpoints (T-0072 E11.1 — additive).
  // T-0376: actor-scoped /api/forms/binding routes require resolveActorTenant deps.
  if (grantsPool) {
    registerBindingRoutes(router, grantsPool, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
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

  // T-0562 (PD-26 / ADR T-0561): «Опубликовать связанное решение по кнопке».
  //   GET  /api/applications/:id/publish-preview  — derive the connected set (1 hop:
  //        app + x-relation справочники + bound processes + step forms) + per-item tier.
  //   POST /api/applications/:id/publish-solution — promote each draft item, REUSING
  //        promoteTier (application) + publishProcessByKey (process). Per-item results;
  //        200 all-ok / 207 partial. NO stored 'partial' state — the response is truth.
  // Privileged: owner/admin OR authoring_draft (resolveActorPrivilege, T-0557) → else 403.
  // Needs flowableClient for the process-publish path (publishProcessByKey).
  if (grantsPool && flowableClient) {
    registerSolutionPublishRoutes(router, {
      pool: grantsPool,
      flowable: flowableClient,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // Register sections (разделы) CRUD API (T-0551 E-NAV-IA — раздел = первоклассная
  // сущность/папка, РЕВЕРС T-0540 строки). Tenant-scoped via withTenantTx + RLS
  // (policy section_tenant_isolation); actor's tenant resolved from the dev-user
  // slug / KC sub, never from headers. Same deps as applications.
  if (grantsPool) {
    registerSectionRoutes(router, {
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
  // T-0351 E16: flowableClient passed so on_create bindings fire process start
  // in the same tx as record creation (create = start, S1 seam). When flowableClient
  // is null (no engine configured) the on_create trigger is silently skipped
  // (honest-degrade — record still created, no process started).
  if (grantsPool) {
    registerRecordRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
      // T-0419 (D7-3-FU): field-visibility resolver — active in production.
      // coveringGrants: same getGrantsForSubject DAO used by the full PDP
      //   (single-resolver constraint — no second authority path).
      // policy: derived from data_classification rows for the tenant (T-0081 §4.1):
      //   fields classified 'confidential'/'restricted' become roleScopedFields;
      //   no new store — projection of existing migration-017 rows.
      // Honest-degrade: if grantsPool is null (no DB), this dep is absent and
      //   redaction degrades to a no-op (NF-1, block above guards).
      resolveFieldVisibility: async (actorSlug: string, tenantId: string, nowMs: number) => ({
        coveringGrants: await getGrantsForSubject(grantsPool, tenantId, actorSlug, nowMs),
        policy: await getFieldVisibilityPolicy(grantsPool, tenantId),
      }),
      // T-0570 (D3, READ-PDP): read-visibility resolver — active in production,
      // wired in the SAME commit that ships migrations/115 (the default-open
      // backfill), so the gate never turns on before every tenant has a
      // covering grant (NF-2). grants: same getGrantsForSubject DAO as every
      // other PDP consumer (single-resolver, FR-7). ancestry: composite oracle
      // — org hierarchy delegates to the real per-tenant department tree
      // (loadTenantOrgAncestry, unchanged semantics); resource hierarchy answers
      // via the RESOURCE_ROOT sentinel (O(1) "covers everything", ADR §2.1 rule
      // 2) and self-identity (rule 1, record-scoped narrow grants, AC-5) without
      // materializing a per-tenant resource map. The rowIndex is empty here
      // (rule 3 registry/application-scoped narrowing — an explicit, documented
      // future increment, ADR §2.1/§5 out-of-scope) — record-scoped narrow
      // grants (rule 1) and the default-open root grant (rule 2) both work fully.
      resolveReadVisibility: async (actorSlug: string, tenantId: string, nowMs: number) => {
        const [grants, orgOracle] = await Promise.all([
          getGrantsForSubject(grantsPool, tenantId, actorSlug, nowMs),
          loadTenantOrgAncestry(grantsPool, tenantId),
        ]);
        const emptyRowIndex = new Map<string, RowAncestry>();
        return {
          grants,
          ancestry: makeResourceAncestryOracle(orgOracle, emptyRowIndex),
        };
      },
      // T-0351 E16: wire the shared flowableClient for on_create trigger.
      flowable: flowableClient ?? undefined,
      // T-0536 [D8-R4 delivery]: wire the internal-signal emitter so a committed
      // record UPDATE broadcasts the generic «record-status-changed» signal WITHIN
      // the record's tenant (keyed by the record id), advancing any process parked
      // on a matching signal-catch. Reuses the SAME deliverMessageEnvelope path as
      // POST /api/message via emitInternalSignal. Only when a live engine is present
      // (honest-degrade: no signal path without an engine to fire the catch).
      emitSignal: flowableClient
        ? async ({ tenantId, recordId, registryDefId, actor, nowMs }) => {
            await emitInternalSignal(
              {
                pool: grantsPool,
                resolveActorTenant: (s: string) => resolveActorTenant(getOrgPool(), s),
                engine: flowableClient,
              },
              {
                tenantId,
                signalName: RECORD_STATUS_SIGNAL,
                // Generic business key: the record id. A process binds its
                // signal-catch correlationField to resolve to this record's id.
                correlationKey: recordId,
                payload: { record_id: recordId, registry_def_id: registryDefId },
                actor,
                nowMs,
              },
            );
          }
        : undefined,
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
  // T-0489 G2 [SECURITY]: withAuth-wrapped at the registration site + tenant from the
  // actor's own row (resolveActorTenant, fail-closed) instead of the hardcoded Dev Silo.
  registerArtifactRoutes(router, {
    resolveActorTenant: (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
  });

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
  // T-0489 G2 [SECURITY]: withAuth-wrapped at the registration site + tenant from the
  // actor's own row (resolveActorTenant, fail-closed) instead of the hardcoded Dev Silo.
  registerReportPageRoutes(router, undefined, undefined, (actorSlug: string) =>
    resolveActorTenant(getOrgPool(), actorSlug),
  );

  // Register Floor-1 aggregate renderer + Floor-2 RLS-gated data API (T-0181 T-0121g).
  // T-0489 G2 [SECURITY]: withAuth-wrapped at the registration site + tenant from the
  // actor's own row (resolveActorTenant, fail-closed) instead of the hardcoded Dev Silo.
  registerReportPageRenderRoutes(router, undefined, undefined, (actorSlug: string) =>
    resolveActorTenant(getOrgPool(), actorSlug),
  );

  // Register Floor-1 form editor (T-0073 E11.2 — stateless pure transform).
  // Pool is used solely for the keycloak-mode process_designer authz lookup
  // (review R-1); dev mode works without it, so wiring stays unconditional.
  registerFloor1EditorRoutes(router, grantsPool ?? null);

  // Register DMN rule table WRITE API (T-0433).
  // Endpoints: GET/POST /api/dmn-rule-tables, POST /api/dmn-rule-tables/:id/publish.
  // Deps-gated on grantsPool — honest-degrade when no DATABASE_URL.
  // D-056: rows land in choros.dmn_rule_table (same table loadPublishedRuleTables reads).
  if (grantsPool) {
    registerDmnRuleTableRoutes(router, grantsPool);
  }

  // Register vendor activation + vendor-service endpoints (T-0127 / T-0198).
  // The ONLY HTTP surface that reads activation/entitlement state. GET /vendor/activation
  // always 200 (reporting is not gating); vendor-service calls return 402/403 when the
  // subscription does not grant the service. Core/user endpoints never read the key.
  registerVendorActivationRoutes(router);

  // Register process-definition CRUD + publish routes (T-0252 E8 C2).
  // Requires grantsPool (same tenant RLS pattern) + the shared FlowableClient
  // composed above from env (NO env reads in core — NF-1).
  if (grantsPool && flowableClient) {
    // T-0468 [SECURITY]: tenant comes from the actor's identity (resolveActorTenant),
    // never from an x-tenant-id header — same injection shape as applications.ts.
    registerProcessDefsRoutes(
      router,
      grantsPool,
      flowableClient,
      (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
    );

    // T-0465 (D8-G4): bundle-promote — publish a whole text-first solution bundle
    // (apps + sections + processes tagged with one bundle_id) as ONE unit. Reuses
    // promoteTier (config tier) + publishProcessByKey (process publish). Human-gated.
    registerSolutionBundleRoutes(router, {
      pool: grantsPool,
      flowable: flowableClient,
      resolveActorTenant: (actorSlug: string) => resolveActorTenant(getOrgPool(), actorSlug),
    });
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

  // T-0352 (E16): Register GET /api/records/:id/links — 1-hop LIVE cross-app
  // projection for the record card (§6 card policy: lazy, per-section expand).
  // Deps-gated on grantsPool — honest-degrade when no DATABASE_URL.
  // APPEND-ONLY: must be the last register* call before setFallback.
  registerRecordLinksRoutes(
    router,
    grantsPool
      ? {
          pool: grantsPool,
          resolveActorTenant: (actorSlug: string) =>
            resolveActorTenant(getOrgPool(), actorSlug),
        }
      : undefined,
  );

  // T-0363 (c): Wire analyst production ports so handleAnalyst reads real DB data.
  // Ports are read-only (RecordLister, CycleTimeLister, ActorBreakdownLister).
  // T-0383 (D5): also wire loadSystemPrompt port for per-tenant analyst prompt override.
  // Honest-degrade: when grantsPool is null (no DB) the default no-op ports remain.
  if (grantsPool) {
    setAnalystPorts({
      loadCycleTime: (tenantId: string) =>
        loadCycleTimeByActivity(grantsPool, tenantId),
      loadActorBreakdown: (tenantId: string) =>
        loadActorTypeBreakdown(grantsPool, tenantId),
      // listRecords: not wired here (requires ACL-filter factory integration with
      // intersectionGrants at call-time — T-0360 follow-up). Defaults to [].
      // T-0383: per-tenant analyst system prompt (reads published instruction_meta).
      loadSystemPrompt: (tenantId: string) =>
        readPublishedAssistantPrompt(grantsPool, tenantId, "analyst"),
    });
  }

  // T-0359 (E17): Register AI-assistant routes (thread/message/budget).
  // T-0363 (b): llmPortFactory now wires DeepSeek when DEEPSEEK_API_KEY is set.
  // T-0382 (D5): llmPortFactory is now async and reads per-tenant agent_card config
  //   first, falling back to global env (backward-compatible).
  // Deps-gated on grantsPool — honest-degrade when no DATABASE_URL.
  // APPEND-ONLY: the last register* call before setFallback.
  if (grantsPool) {
    registerAssistantRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
      // T-0382: async factory — reads per-tenant agent_card llm_* then falls back
      // to global DEEPSEEK_API_KEY env; dormantLlmPort → 503 when neither is set.
      llmPortFactory: (tenantId: string) => makeLlmPortFactory(tenantId, grantsPool),
      // T-0477 [E-AGENTS L5]: spend-tracking context factory — resolves the default
      // llm_connection for the tenant (for prices/connection_id). Non-fatal: returns
      // null when the tenant has no default connection or on DB error.
      spendTrackingFactory: async (tenantId: string) => {
        try {
          const client = await grantsPool.connect();
          let conn = null;
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
            await client.query("SET LOCAL search_path TO choros");
            conn = await getDefaultLlmConnection(client as unknown as import("./db/audit-writer.js").PgClientLike, tenantId);
            await client.query("COMMIT");
          } catch {
            await client.query("ROLLBACK").catch(() => {});
          } finally {
            client.release();
          }
          if (!conn) return null;
          return {
            pool: grantsPool,
            tenantId,
            connectionId: conn.id,
            priceInputPer1k: conn.priceInputPer1k,
            priceOutputPer1k: conn.priceOutputPer1k,
            currency: conn.currency,
          };
        } catch {
          return null;
        }
      },
    });
  }

  // T-0382 (D5): LLM connection screen backend (GET/PUT per-tenant LLM config).
  // Additive — registers two routes to read/write llm_endpoint+llm_model on agent_card.
  // Secret-handle binding remains via the existing POST /api/agents/:id/secret-handle.
  if (grantsPool) {
    registerLlmConfigRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // T-0474 (E-AGENTS L2): named LLM connection registry routes.
  // GET/POST /api/llm-connections — list/create reusable LLM connection profiles
  // (migration 094 choros.llm_connection). Management-tier gated, tenant-scoped via
  // resolveActorTenant + withTenantTx (FORCE RLS). The opaque secret handle is never
  // egressed (secret_bound boolean + redacted scheme only).
  if (grantsPool) {
    registerLlmConnectionsRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // T-0476 (E-AGENTS L3): app:// encrypted secret store — "вставить API-ключ".
  // POST/GET-status/DELETE /api/llm-connections/:id/key — write-only key binding.
  // The raw key is encrypted (AES-256-GCM) into app_secret and the connection's
  // secret_handle is set to app://<id>; the key is NEVER returned/logged. DORMANT
  // (503 honest) when APP_SECRET_MASTER_KEY is unset. Read at the composition root.
  if (grantsPool) {
    registerAppSecretRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
      getMasterKey: () => process.env["APP_SECRET_MASTER_KEY"],
    });
  }

  // T-0496: "Проверить подключение" — server-side LLM connection probe.
  // POST /api/llm-connections/:id/test makes ONE minimal chat call through the
  // existing OpenAILlmPort adapter using the REAL tenantSecretResolver (app:// decrypt
  // in memory). Same authz as edit (owner OR llm_connection:configure), tenant-scoped.
  // The raw key NEVER leaves the adapter; provider errors are sanitized before egress.
  if (grantsPool) {
    registerLlmConnectionTestRoute(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
      // Composition-root factory: builds the live port with the tenant secret resolver.
      // Returns null when the connection cannot produce a usable port (invalid handle
      // shape or no resolvable endpoint) — the route maps null → honest ok:false.
      makeLlmPort: ({ tenantId, endpoint, model, secretHandle }) => {
        // RL-3: only an opaque handle (app:///vault://) is usable. A malformed handle
        // (or one that slipped through as a raw key) is rejected here — never sent.
        const verdict = validateSecretHandleShape(secretHandle);
        if (!verdict.ok) return null;
        // The connection's own endpoint is preferred; fall back to the DeepSeek base
        // only when the profile left it blank (a self-hosted/other profile must set one).
        const ep = endpoint && endpoint.length > 0 ? endpoint : DEEPSEEK_BASE_URL;
        return new OpenAILlmPort({
          endpoint: ep,
          model: model && model.length > 0 ? model : DEEPSEEK_MODEL,
          secretHandle,
          tenantId,
          secretResolver: tenantSecretResolver,
          // A probe must fail fast — cap the wait so a dead endpoint returns promptly.
          timeoutMs: 15_000,
        });
      },
    });
  }

  // T-0383 (D5/PD-6): per-tenant assistant system prompt routes.
  // GET/PUT /api/assistant/prompt/:role ('analyst' | 'configurator').
  // Additive — registers two routes per role for the prompt editor UI.
  if (grantsPool) {
    registerAssistantPromptRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // T-0477 [E-AGENTS L5]: spend accounting routes (Расход screen backend).
  // GET /api/spend — aggregates (windows + by-connection).
  // GET /api/spend/recent — most-recent N rows.
  // Auth: any tenant member (read-only accounting — no mutations, no ceilings).
  if (grantsPool) {
    registerSpendRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // T-0405 [PD-20]: operational analytics — GROUP BY on index, lightweight result,
  // xlsx/csv export. GET /api/operational-analytics, GET /api/operational-analytics/export.
  if (grantsPool) {
    registerOperationalAnalyticsRoutes(router, {
      pool: grantsPool,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
  }

  // T-0518: file attachment routes.
  // POST /api/records/:recordId/files  — upload file (raw body, X-File-Name header)
  // GET  /api/records/:recordId/files  — list files on a record
  // GET  /api/files/:fileVersionId/download — stream/redirect to file content
  //
  // FsObjectStore rootDir: FILE_STORE_ROOT env (default /app/uploads — ephemeral
  // in-container; a persistent volume mount is an operator concern, not wired here).
  // The PDP uses makeFileRecordResolver (record-derived authz, no file ACL).
  if (grantsPool) {
    const fileStoreRoot = process.env["FILE_STORE_ROOT"] ?? "/app/uploads";
    const pgFileStore = new PgFileStore(grantsPool);
    const fsObjectStore = new FsObjectStore(fileStoreRoot);
    // Build a per-request-style FileRecordResolver that loads grants + ancestry
    // fresh from DB each call (same pattern as pdp-explain.ts). The grant source
    // uses makeDbGrantSource (same DAO as the full PDP). Ancestry: load per-tenant
    // from DB (loadTenantOrgAncestry); fall back to SEED_ORACLE on error
    // (ancestry is only consulted for org-scoped grants, not simple record grants).
    const fileGrantSource = makeDbGrantSource(grantsPool);
    const fileResolver = makeFileRecordResolver({
      grants: fileGrantSource,
      records: {
        async getRecord(ref) {
          if (ref.kind !== "record") return { __sentinel__: true };
          const client = await grantsPool.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL choros.tenant_id = '${ref.tenantId}'`);
            await client.query("SET LOCAL search_path TO choros");
            const { rows } = await client.query<{ data: Record<string, unknown> }>(
              `SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
              [ref.tenantId, ref.recordId],
            );
            await client.query("COMMIT");
            return rows.length > 0 ? (rows[0]!.data ?? {}) : null;
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        },
      },
      ancestry: SEED_ORACLE,
    });
    registerFileRoutes(router, {
      pool: grantsPool,
      fileStore: pgFileStore,
      objectStore: fsObjectStore,
      resolver: fileResolver,
      resolveActorTenant: (actorSlug: string) =>
        resolveActorTenant(getOrgPool(), actorSlug),
    });
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
