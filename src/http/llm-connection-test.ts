/**
 * src/http/llm-connection-test.ts — T-0496
 *
 * "Проверить подключение" — server-side LLM connection probe.
 *
 * Route:
 *   POST /api/llm-connections/:id/test
 *     → resolves the connection's secret IN MEMORY, makes ONE minimal chat call
 *       through the existing LlmPort adapter, and answers honestly:
 *         { ok: true,  model, latency_ms, tokens? }   — the key works
 *         { ok: false, error: "<sanitized human message>" } — provider/network/key error
 *       (HTTP 200 in BOTH cases — ok:false is a TEST RESULT, not a server fault.
 *        5xx is reserved for a genuine internal failure, e.g. the DB is down.)
 *
 * Auth: same x-dev-user / keycloak-Bearer pattern as llm-connections.ts / app-secret.ts.
 * Authz (spec §6): probing a connection = canConfigureLlmConnection (genesis-owner OR the
 *   llm_connection:configure capability) — EXACTLY the edit gate, never weaker. A plain
 *   member → 403; unauthenticated → 401.
 * Tenant isolation: resolveActorTenant → withTenantTx (SET LOCAL + FORCE RLS) + the DAO's
 *   explicit WHERE tenant_id double-predicate (getLlmConnection). A connection id owned by
 *   another tenant is invisible (RLS + predicate) → 404. You cannot probe a foreign id.
 *
 * NON-EGRESS (RL-3 — the keystone invariant): the raw API key flows ONLY inside the
 * injected LlmPort adapter (resolveSecret → Authorization header). It is NEVER placed in
 * the response, an error message, an audit payload, or a log. Provider error strings —
 * which can echo a fragment of the submitted key — are passed through sanitizeProviderError
 * (drops the full text, keeps only a status-class hint) before they reach the client.
 *
 * REUSE (no new HTTP/provider code here):
 *   - secret resolution: the injected `makeLlmPort` is wired at the composition root
 *     (server.ts) with the REAL tenantSecretResolver (app:// decrypt-in-memory) — the
 *     same resolver the assistant path uses. This module never touches process.env, never
 *     opens an https socket, never reads a raw key.
 *   - the provider call: the injected LlmPort is an OpenAILlmPort (src/adapters), whose
 *     chat() owns the only network path. We just call port.chat() with a 1-token ping.
 */

import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { canConfigureLlmConnection } from "../db/capability-grants-dao.js";
import type { PgClientLike } from "../db/audit-writer.js";
import { getLlmConnection, type LlmConnectionRow } from "../db/llm-connection-dao.js";
import type { LlmPort } from "../core/llm-port.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * Build a live LlmPort for a resolved connection profile. Wired at the composition
 * root (server.ts) — it constructs the OpenAILlmPort with the REAL tenant secret
 * resolver. The raw key NEVER appears here; it lives only inside the returned port.
 *
 * Returns null when the connection cannot produce a live port (e.g. no usable endpoint
 * — provider config too thin to even attempt a call). The handler maps null to an
 * honest ok:false rather than a crash.
 */
export type LlmPortFactory = (input: {
  readonly tenantId: string;
  readonly endpoint: string | null;
  readonly model: string | null;
  readonly secretHandle: string;
}) => LlmPort | null;

export interface LlmConnectionTestRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  /** Builds the live LlmPort (OpenAILlmPort) for a connection — composition-root wiring. */
  makeLlmPort: LlmPortFactory;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Auth helper (same pattern as llm-connections.ts / app-secret.ts)
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors llm-connections.ts (SET LOCAL + FORCE RLS)
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
// sanitizeProviderError — RL-3 NON-EGRESS for the test result.
//
// A provider/network error string can echo a fragment of the submitted key (some
// providers reflect the Authorization header in 401 bodies). We therefore NEVER
// pass the raw error text to the client. We map the error to a short, human,
// key-free message keyed off a coarse status/shape signal.
// ---------------------------------------------------------------------------

export function sanitizeProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // T-0497: SSRF guard blocked the endpoint (private/loopback/metadata range).
  // The error name is checked first so we never echo the raw message (which
  // contains the blocked-range classification, safe but unnecessary to expose).
  if ((err instanceof Error && err.name === "SsrfBlockedError") || /SSRF guard/i.test(raw)) {
    return "Эндпойнт заблокирован: адрес относится к приватному или зарезервированному диапазону.";
  }

  // Dormant port (no live config) — the adapter/port refused before any network.
  if (/dormant/i.test(raw)) {
    return "LLM-порт не активен (подключение не сконфигурировано).";
  }

  // Timeout — the only safe substring we trust (it is our own adapter message).
  if (/timeout/i.test(raw)) {
    return "Превышено время ожидания ответа провайдера.";
  }

  // Provider HTTP status — extract ONLY the status code class, never the body.
  // The OpenAILlmPort error shape is: "OpenAI API error <code>: <body>" — we drop
  // the body entirely and keep only the numeric code (which carries no secret).
  const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(raw);
  if (statusMatch) {
    const code = statusMatch[1];
    if (code === "401" || code === "403") {
      return "Провайдер отклонил ключ (неверный или недействительный API-ключ).";
    }
    if (code === "404") {
      return "Провайдер не нашёл эндпойнт или модель (проверьте URL/название модели).";
    }
    if (code === "429") {
      return "Провайдер ограничил частоту запросов (rate limit). Повторите позже.";
    }
    if (code.startsWith("5")) {
      return `Провайдер вернул ошибку сервера (${code}).`;
    }
    return `Провайдер отклонил запрос (${code}).`;
  }

  // Secret-resolution failures (handle not found / store unconfigured) — these come
  // from the resolver via redactHandle (no raw key), but we still normalise them.
  if (/secret store is not configured|APP_SECRET_MASTER_KEY/i.test(raw)) {
    return "Хранилище ключей не настроено на сервере. Обратитесь к оператору.";
  }
  if (/secret not found|not resolvable|cannot resolve handle|unknown secret handle/i.test(raw)) {
    return "Ключ не найден или ссылка-хэндл недействительна.";
  }
  if (/env:\/\/ handles are system-only/i.test(raw)) {
    return "Эта ссылка-хэндл (env://) недоступна как ключ тенанта.";
  }

  // Network-level errors (ENOTFOUND / ECONNREFUSED / etc.) — keep only the class.
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Не удалось разрешить адрес эндпойнта (DNS).";
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(raw)) {
    return "Не удалось соединиться с эндпойнтом провайдера.";
  }
  if (/invalid JSON response|non-JSON response/i.test(raw)) {
    return "Провайдер вернул неожиданный ответ (не JSON).";
  }

  // Fallback — NEVER echo the raw text (it may carry a key fragment).
  return "Подключение не удалось проверить (ошибка провайдера).";
}

// ---------------------------------------------------------------------------
// POST /api/llm-connections/:id/test
// ---------------------------------------------------------------------------

interface TestOk {
  ok: true;
  model: string | null;
  latency_ms: number;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}
interface TestFail {
  ok: false;
  error: string;
}

async function handleTest(
  deps: LlmConnectionTestRouteDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  connectionId: string,
): Promise<void> {
  const { pool, resolveActorTenant, makeLlmPort } = deps;
  const actor = extractActor(req);
  assertUuidShape(connectionId, "connectionId");
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  // Authz — EXACTLY the edit gate (owner OR llm_connection:configure). Never weaker.
  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(
      403,
      "LLM_CONNECTION_CONFIGURE_REQUIRED",
      "requires owner or llm_connection:configure grant",
    );
  }

  // Load the connection STRICTLY within the actor's tenant (RLS + predicate). A
  // foreign id is invisible → 404; you cannot probe another tenant's connection.
  const conn: LlmConnectionRow | null = await withTenantTx(pool, tenantId, (client) =>
    getLlmConnection(client as unknown as PgClientLike, tenantId, connectionId),
  );
  if (!conn) {
    throw new HttpError(404, "CONNECTION_NOT_FOUND", "connection profile not found");
  }

  // No key bound → honest ok:false (NOT a 500). Nothing to probe.
  if (conn.secretHandle === null || conn.secretHandle === "") {
    return sendJson(res, 200, { ok: false, error: "Ключ не задан" } satisfies TestFail);
  }

  // Build the live port (composition-root factory wires the REAL secret resolver).
  // The raw key is never visible here — it lives only inside the returned port.
  const port = makeLlmPort({
    tenantId,
    endpoint: conn.endpoint,
    model: conn.model,
    secretHandle: conn.secretHandle,
  });
  if (port === null) {
    // Provider config too thin to even attempt a call (e.g. no usable endpoint).
    return sendJson(res, 200, {
      ok: false,
      error: "Подключение не сконфигурировано для проверки (нет эндпойнта/модели).",
    } satisfies TestFail);
  }

  // ONE minimal chat call — deliberately the cheapest probe (single 'ping' turn).
  // No retry, no loop: this is a key test, not a workload.
  const t0 = Date.now();
  try {
    const result = await port.chat({
      system: "",
      messages: [{ role: "user", content: "ping" }],
    });
    const latencyMs = Date.now() - t0;
    const ok: TestOk = {
      ok: true,
      model: conn.model,
      latency_ms: latencyMs,
    };
    if (result.usage) {
      ok.tokens = {
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        total: result.usage.totalTokens,
      };
    }
    return sendJson(res, 200, ok);
  } catch (err) {
    // Provider/network/key error → ok:false with a SANITIZED message (RL-3: the raw
    // error — which may echo a key fragment — never reaches the client). HTTP 200:
    // a failed probe is a valid TEST RESULT, not a server fault.
    return sendJson(res, 200, {
      ok: false,
      error: sanitizeProviderError(err),
    } satisfies TestFail);
  }
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: TestOk | TestFail,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register POST /api/llm-connections/:id/test. Additive — touches no existing routes.
 */
export function registerLlmConnectionTestRoute(
  router: Router,
  deps: LlmConnectionTestRouteDeps,
): void {
  router.register(
    "POST",
    "/api/llm-connections/:id/test",
    withAuth(async (req, res, params) =>
      handleTest(deps, req, res, params["id"] ?? ""),
    ),
  );
}
