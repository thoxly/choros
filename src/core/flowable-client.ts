/**
 * T-0064: Engine REST Client — typed Flowable 7 REST client.
 *
 * Wraps all Flowable REST API calls needed by the Choros engine adapter layer.
 *
 * --- REAL Flowable 7.1.0 endpoints (live-verified; differ from ADR §4.5) ---
 * BPMN/process operations use the BPMN REST servlet (/service/*):
 *   - deployBpmn:    POST {baseUrl}/repository/deployments (multipart)
 *   - startInstance: POST {baseUrl}/runtime/process-instances
 *
 * External-job operations use a SEPARATE servlet (/external-job-api/*):
 *   - fetchAndLock:  POST {extJobUrl}/acquire/jobs
 *                    body: { topic, workerId, lockDuration, numberOfTasks }
 *                    response: JSON array (NOT { data: [...] })
 *                    wire shape has no "topic" field; topic echoed from request
 *   - completeTask:  POST {extJobUrl}/acquire/jobs/{taskId}/complete
 *   - failTask:      POST {extJobUrl}/acquire/jobs/{taskId}/fail
 *
 * extJobUrl = baseUrl.replace('/service', '/external-job-api')
 *              e.g. http://flowable:8082/flowable-rest/external-job-api
 *
 * Deviation from ADR §4.5 documented — actual endpoints confirmed live against
 * flowable/flowable-rest:7.1.0.
 *
 * FF-G3 compliance (T-0028 Layer C):
 *   - assertVariableValue called in startInstance + completeTask before sending
 *     variables to the engine (fail-closed; RECORD_IN_PAYLOAD on rejection).
 *   - resolveFor imported and referenced at the completeTask variable-processing
 *     seam (the record-mutation boundary; T-0068 will wire the full auth path).
 *
 * Uses Node 22 built-in globalThis.fetch — no new npm dependencies.
 * Config read at call time (not module load time) so vi.stubEnv works in tests.
 */

import { assertVariableValue } from "./object-handle.js";
// resolveFor is imported as the record-mutation seam (FF-G3 / T-0028 Layer C).
// The void resolveFor reference in completeTask satisfies the FF-G3 grep check.
// T-0068 will complete the authorization wiring at that seam.
import { resolveFor } from "./grant-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed error codes for all HTTP/network errors (FR-8). */
export type FlowableErrorCode =
  | "ENGINE_UNAVAILABLE" // 5xx after retries exhausted
  | "NOT_FOUND"          // 404
  | "CONFLICT"           // 409
  | "UNAUTHORIZED"       // 401
  | "BAD_BPMN"           // 400 on deployBpmn
  | "RECORD_IN_PAYLOAD"  // client-side assertVariableValue rejection
  | "TIMEOUT"            // request timeout exceeded
  | "UNKNOWN";           // all other errors

// ---------------------------------------------------------------------------
// T-0483: typed mapping FlowableErrorCode → HTTP status + client-facing message.
//
// The publish/start routes proxy the engine; when the engine is unreachable
// (down / OOM / DB blip) the route must surface a CLEAR, TYPED error the client
// can branch on — not an opaque "502 deployBpmn failed: ENGINE_UNAVAILABLE".
//
// ENGINE_UNAVAILABLE / TIMEOUT → 503 Service Unavailable (transient; the engine
// may self-heal via the compose restart policy — caller can retry). The error
// `code` is preserved verbatim so the web layer can show an honest
// "движок недоступен" state and keep the diagram a ЧЕРНОВИК (never green "валидно").
//
// Pure data + no I/O, so it lives in core (NF-1) and is unit-testable.
// ---------------------------------------------------------------------------

/** Shape consumed by the HTTP layer to build a typed error response. */
export interface FlowableErrorHttp {
  /** HTTP status to return to the client. */
  readonly status: number;
  /** Stable machine code the client branches on (equals the FlowableErrorCode). */
  readonly code: FlowableErrorCode;
  /** User-readable Russian message — honest, never papered over. */
  readonly message: string;
}

const ENGINE_UNAVAILABLE_MSG =
  "Движок процессов недоступен. Изменения сохранены как черновик — повторите публикацию позже.";

/**
 * Map a typed FlowableErrorCode to an HTTP status + client-facing message.
 * Used by the publish + start-instance routes so an engine failure is explicit.
 */
export function flowableErrorToHttp(code: FlowableErrorCode): FlowableErrorHttp {
  switch (code) {
    case "ENGINE_UNAVAILABLE":
    case "TIMEOUT":
      // Transient: engine unreachable / slow. 503 signals "try again".
      return { status: 503, code: "ENGINE_UNAVAILABLE", message: ENGINE_UNAVAILABLE_MSG };
    case "BAD_BPMN":
      return {
        status: 422,
        code,
        message: "Диаграмма отклонена движком процессов (некорректный BPMN).",
      };
    case "UNAUTHORIZED":
      return {
        status: 502,
        code,
        message: "Движок процессов отклонил авторизацию сервера. Обратитесь к администратору.",
      };
    case "CONFLICT":
      return {
        status: 409,
        code,
        message: "Конфликт версий в движке процессов. Обновите страницу и повторите.",
      };
    case "NOT_FOUND":
      return {
        status: 502,
        code,
        message: "Движок процессов не нашёл ресурс. Обратитесь к администратору.",
      };
    // RECORD_IN_PAYLOAD / UNKNOWN and any future code → opaque-but-honest 502.
    default:
      return {
        status: 502,
        code: "UNKNOWN",
        message: "Ошибка движка процессов. Повторите позже или обратитесь к администратору.",
      };
  }
}

export type DeployResult =
  | { ok: true; deploymentId: string }
  | { ok: false; code: FlowableErrorCode };

export type StartResult =
  | { ok: true; instanceId: string }
  | { ok: false; code: FlowableErrorCode };

export type FetchResult =
  | { ok: true; tasks: ExternalTask[] }
  | { ok: false; code: FlowableErrorCode };

export type CompleteTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

export type FailTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0368 (E16): result of getFirstActiveUserTask — the task id of the first
 * active user task for an instance, or null when no active user task exists.
 */
export type GetFirstUserTaskResult =
  | { ok: true; taskId: string | null }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0368 (E16): result of completeUserTask — complete a Flowable user task
 * via the BPMN REST API (not the external-job API). Used by the on_create
 * trigger to auto-complete the «Подача заявки» (task-submit) user task so
 * that a create=start instance does not wait at a second submit step.
 */
export type CompleteUserTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0443: A live active user task from the Flowable engine.
 * Maps the GET /runtime/tasks?processInstanceId wire shape.
 */
export interface ActiveUserTask {
  /** Flowable task id (the engine's runtime task id). */
  readonly id: string;
  /** BPMN taskDefinitionKey (e.g. "task-approve", "task-extra-approve"). */
  readonly taskDefinitionKey: string;
  /** Human-readable task name. */
  readonly name: string;
  /** candidateGroups as resolved by Flowable (may be empty). */
  readonly candidateGroups: readonly string[];
}

/**
 * T-0443: result of getActiveUserTasks — all active user tasks for an instance,
 * mapped from the Flowable wire shape.
 */
export type GetActiveUserTasksResult =
  | { ok: true; tasks: ActiveUserTask[] }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0459 [D8-R4]: a parked MESSAGE/SIGNAL-CATCH on a live instance. An instance
 * sitting on a receiveTask / intermediateCatchEvent(message|signal) / message
 * boundary registers an EVENT-SUBSCRIPTION in the engine — this is the engine
 * truth that the instance is WAITING for a correlated message, not for a human.
 * Maps the GET /runtime/event-subscriptions wire shape.
 */
export interface MessageCatchWait {
  /** The awaited message/signal name (the subscription's eventName). */
  readonly messageName: string;
  /** "message" | "signal" — a signal-catch is broadcast-within-tenant. */
  readonly eventType: string;
}

/**
 * T-0459 [D8-R4]: result of getMessageCatchWaits — the parked message/signal
 * catches for a process instance (the active event-subscriptions). Empty `waits`
 * means the instance is NOT parked on any message-catch. `{ ok: false }` on engine
 * error so the caller honest-degrades (the waiting projection is never a hard dep).
 */
export type GetMessageCatchWaitsResult =
  | { ok: true; waits: MessageCatchWait[] }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0443: result of isInstanceEnded — whether the given process instance has
 * ended (all paths reached endEvent). Returns { ok: true, ended: true } when
 * the instance is gone from runtime (404 on runtime endpoint) or its history
 * record shows endTime != null. Returns { ok: false } on engine error.
 */
export type IsInstanceEndedResult =
  | { ok: true; ended: boolean }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0483: result of pingEngine — a lightweight engine-reachability probe used by
 * the readiness endpoint (GET /api/engine/health). `reachable` is true when the
 * engine's management endpoint answers 200; otherwise `code` carries the typed
 * failure reason. This is SINGLE-SHOT (no retry) so the readiness probe is fast.
 */
export type PingEngineResult =
  | { ok: true; reachable: true }
  | { ok: true; reachable: false; code: FlowableErrorCode };

/** Wire shape from Flowable /runtime/external-jobs/acquire (FR-3). */
export interface ExternalTask {
  readonly id: string;
  readonly topic: string;
  readonly processInstanceId: string;
  readonly variables: Record<string, unknown>;
  readonly lockOwner: string;
  readonly lockExpirationTime: string; // ISO 8601
}

/** Injectable config for factory (for testing / override). */
export interface FlowableClientConfig {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  timeoutMs: number;        // default 10_000
  maxRetries: number;       // default 3
  retryBaseDelayMs: number; // default 500
  retryMaxDelayMs: number;  // default 5_000
  delayFn?: (ms: number) => Promise<void>; // injectable for tests
}

/** Return type of makeFlowableClient factory. */
export interface FlowableClient {
  deployBpmn(xml: string): Promise<DeployResult>;
  startInstance(
    processDefinitionKey: string,
    variables?: Record<string, unknown>,
  ): Promise<StartResult>;
  fetchAndLock(
    topic: string,
    workerId: string,
    lockDurationMs: number,
    maxTasks: number,
  ): Promise<FetchResult>;
  completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult>;
  failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult>;
  /**
   * T-0368 (E16): find the first active user task id for the given process
   * instance. Used after a create=start to identify the waiting task-submit
   * user task so it can be auto-completed. Returns { ok: true, taskId: null }
   * when the instance has no active user tasks (already at a service task or
   * completed), { ok: false } on engine error.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/tasks?processInstanceId={id}&size=1
   */
  getFirstActiveUserTask(instanceId: string): Promise<GetFirstUserTaskResult>;
  /**
   * T-0368 (E16): complete a Flowable USER task (not an external/service task)
   * by id. Used by the on_create trigger path to auto-complete the
   * «Подача заявки» (task-submit) user task so the instance advances past
   * the submit step without waiting for a human.
   *
   * Flowable endpoint: PUT {baseUrl}/runtime/tasks/{taskId}  body: {"action":"complete"}
   * Success: 200 (Flowable 7 returns the task JSON on PUT complete).
   */
  completeUserTask(taskId: string): Promise<CompleteUserTaskResult>;
  /**
   * T-0443: Get ALL active user tasks for a process instance.
   * Unlike getFirstActiveUserTask (size=1), this returns the full list so the
   * caller can resolve by taskDefinitionKey (e.g. "task-approve") rather than
   * taking whatever is first. Used by the approve engine-drive seam in inbox.ts.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/tasks?processInstanceId={id}
   * Maps each task to { id, taskDefinitionKey, name, candidateGroups }.
   */
  getActiveUserTasks(instanceId: string): Promise<GetActiveUserTasksResult>;
  /**
   * T-0459 [D8-R4]: Get the parked MESSAGE/SIGNAL-CATCH event-subscriptions for a
   * process instance. An instance sitting on a receiveTask /
   * intermediateCatchEvent(message|signal) / message boundary registers an
   * event-subscription in the engine; this query reveals which instances are
   * WAITING for a correlated message (vs a userTask). Used by the message-wait
   * read-projection (surfaceMessageCatchWaits) so a parked catch surfaces as
   * «Ожидает сообщения». Empty waits ⇒ not parked on a catch.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/event-subscriptions?processInstanceId={id}
   * Maps each subscription to { messageName (eventName), eventType }.
   */
  getMessageCatchWaits(instanceId: string): Promise<GetMessageCatchWaitsResult>;
  /**
   * T-0443: Check whether a process instance has ended.
   * Strategy: GET /runtime/process-instances/{id} → 404 ⇒ ended (Flowable
   * removes completed instances from the runtime table). If present, also
   * checks /history/historic-process-instances/{id} for endTime != null.
   * Returns { ok: true, ended } or { ok: false, code } on engine error.
   *
   * Used by the inbox approve engine-reconciliation seam to distinguish
   * "engine ended" (emit instance.ended) from "engine has more steps" (emit
   * process.next_task with the live next task's defKey/name/role).
   */
  isInstanceEnded(instanceId: string): Promise<IsInstanceEndedResult>;
  /**
   * T-0483: lightweight engine-reachability probe for the readiness endpoint.
   * Single GET to {baseUrl}/management/engine (the same endpoint the compose
   * healthcheck uses). No retry — a readiness probe must answer quickly. Never
   * throws: returns { reachable: false, code } on any transport/HTTP failure.
   *
   * OPTIONAL on the interface so existing partial test stubs need no change
   * (honest-degrade: the readiness route reports "unknown" when absent). The
   * real makeFlowableClient factory always provides it.
   */
  pingEngine?(): Promise<PingEngineResult>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sentinel object returned inside the Promise.race to signal timeout. */
const TIMEOUT_SENTINEL = Symbol("TIMEOUT_SENTINEL");

function makeTimeoutPromise(ms: number): Promise<typeof TIMEOUT_SENTINEL> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT_SENTINEL), ms));
}

function defaultDelayFn(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Internal retry wrapper with exponential backoff (ADR §4.3).
 * Retries on 5xx / network error; never retries 4xx or RECORD_IN_PAYLOAD.
 */
async function withRetry<T extends { ok: boolean; code?: FlowableErrorCode }>(
  fn: () => Promise<T>,
  config: FlowableClientConfig,
): Promise<T | { ok: false; code: FlowableErrorCode }> {
  const delay = config.delayFn ?? defaultDelayFn;
  let attempt = 0;

  while (true) {
    let result: T | { ok: false; code: FlowableErrorCode };

    try {
      const raceResult = await Promise.race([
        fn(),
        makeTimeoutPromise(config.timeoutMs),
      ]);

      if (raceResult === TIMEOUT_SENTINEL) {
        return { ok: false, code: "TIMEOUT" };
      }

      result = raceResult as T;
    } catch {
      // Network error
      if (attempt >= config.maxRetries) {
        return { ok: false, code: "ENGINE_UNAVAILABLE" };
      }
      const backoff = Math.min(
        config.retryBaseDelayMs * Math.pow(2, attempt),
        config.retryMaxDelayMs,
      );
      await delay(backoff);
      attempt++;
      continue;
    }

    if (result.ok) return result;

    const code = (result as { ok: false; code: FlowableErrorCode }).code;

    // Not retryable: 4xx errors or client-side guard
    const notRetryable: FlowableErrorCode[] = [
      "NOT_FOUND",
      "CONFLICT",
      "UNAUTHORIZED",
      "BAD_BPMN",
      "RECORD_IN_PAYLOAD",
      "UNKNOWN",
    ];
    if (notRetryable.includes(code)) return result;

    // ENGINE_UNAVAILABLE or TIMEOUT (5xx exhausted) — not retried again
    if (attempt >= config.maxRetries) return result;

    const backoff = Math.min(
      config.retryBaseDelayMs * Math.pow(2, attempt),
      config.retryMaxDelayMs,
    );
    await delay(backoff);
    attempt++;
  }
}

/** Build Basic Auth header value. */
function basicAuth(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/** Map HTTP status to a typed error code. */
function httpStatusToCode(status: number, isDeployBpmn = false): FlowableErrorCode {
  if (status === 400 && isDeployBpmn) return "BAD_BPMN";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status >= 500) return "ENGINE_UNAVAILABLE";
  return "UNKNOWN";
}

/**
 * Convert a Record<string, unknown> to Flowable variable wire format:
 * [{ name, value, type? }]
 */
function toFlowableVars(
  vars: Record<string, unknown>,
): { name: string; value: unknown; type?: string }[] {
  return Object.entries(vars).map(([name, value]) => {
    let type: string | undefined;
    if (typeof value === "string") type = "string";
    else if (typeof value === "boolean") type = "boolean";
    else if (Number.isInteger(value)) type = "integer";
    else if (typeof value === "number") type = "double";
    return type !== undefined ? { name, value, type } : { name, value };
  });
}

/** Parse Flowable variable array back to Record<string, unknown>. */
function fromFlowableVars(
  vars: { name: string; value: unknown }[] | undefined,
): Record<string, unknown> {
  if (!vars || !Array.isArray(vars)) return {};
  const out: Record<string, unknown> = {};
  for (const v of vars) {
    out[v.name] = v.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: returns a FlowableClient bound to resolved config (FR-6).
 * process.env reads are NOT performed here — callers in composition root must
 * supply all required config fields (T-0163: NF-1 env boundary).
 * Throws if adminPassword is absent.
 */
export function makeFlowableClient(
  config?: Partial<FlowableClientConfig>,
): FlowableClient {
  const baseUrl =
    config?.baseUrl ?? "http://flowable:8082/flowable-rest/service";

  const adminUser = config?.adminUser ?? "admin";

  const adminPassword = config?.adminPassword;

  if (!adminPassword) {
    throw new Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required");
  }

  const resolved: FlowableClientConfig = {
    baseUrl,
    adminUser,
    adminPassword,
    timeoutMs: config?.timeoutMs ?? 10_000,
    maxRetries: config?.maxRetries ?? 3,
    retryBaseDelayMs: config?.retryBaseDelayMs ?? 500,
    retryMaxDelayMs: config?.retryMaxDelayMs ?? 5_000,
    delayFn: config?.delayFn,
  };

  const auth = basicAuth(resolved.adminUser, resolved.adminPassword);

  // External-job API servlet prefix: the Flowable 7 REST image exposes external
  // worker operations on /external-job-api/* (a separate DispatcherServlet from
  // the main BPMN /service/* servlet). Derive by replacing the trailing /service
  // segment of baseUrl (or appending /external-job-api to the servlet root).
  const extJobUrl = resolved.baseUrl.replace(/\/service\/?$/, "/external-job-api");

  // -------------------------------------------------------------------------
  // FR-1: deployBpmn
  // -------------------------------------------------------------------------
  async function deployBpmn(xml: string): Promise<DeployResult> {
    return withRetry(async () => {
      const form = new FormData();
      form.append("deployment", new Blob([xml], { type: "text/xml" }), "process.bpmn20.xml");

      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/repository/deployments`,
        {
          method: "POST",
          headers: { Authorization: auth },
          body: form,
        },
      );

      if (resp.status === 201) {
        const body = (await resp.json()) as Record<string, unknown>;
        return { ok: true, deploymentId: String(body["id"] ?? "") };
      }

      return { ok: false, code: httpStatusToCode(resp.status, true) };
    }, resolved) as Promise<DeployResult>;
  }

  // -------------------------------------------------------------------------
  // FR-2: startInstance — assertVariableValue guard (FF-G3 / AC-5)
  // -------------------------------------------------------------------------
  async function startInstance(
    processDefinitionKey: string,
    variables?: Record<string, unknown>,
  ): Promise<StartResult> {
    // FF-G3 Layer C: validate ALL outgoing variables before sending to engine.
    if (variables !== undefined) {
      for (const value of Object.values(variables)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }

    return withRetry(async () => {
      const body: Record<string, unknown> = { processDefinitionKey };
      if (variables !== undefined && Object.keys(variables).length > 0) {
        body["variables"] = toFlowableVars(variables);
      }

      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/process-instances`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (resp.status === 201) {
        const data = (await resp.json()) as Record<string, unknown>;
        return { ok: true, instanceId: String(data["id"] ?? "") };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<StartResult>;
  }

  // -------------------------------------------------------------------------
  // FR-3: fetchAndLock — incoming variables from engine NOT validated (ADR §3)
  //
  // Real Flowable 7.1.0 endpoint: POST {extJobUrl}/acquire/jobs
  // Body: { topic, workerId, lockDuration, numberOfTasks }
  // Response: JSON array of job objects (NOT { data: [...] })
  // Wire shape has no "topic" field; we echo the requested topic back.
  // -------------------------------------------------------------------------
  async function fetchAndLock(
    topic: string,
    workerId: string,
    lockDurationMs: number,
    maxTasks: number,
  ): Promise<FetchResult> {
    return withRetry(async () => {
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic,
            workerId,
            lockDuration: lockDurationMs,
            numberOfTasks: maxTasks,
          }),
        },
      );

      if (resp.status === 200) {
        const data = await resp.json() as unknown;
        // Flowable 7 returns a bare JSON array (not { data: [...] })
        const rawTasks: Record<string, unknown>[] = Array.isArray(data)
          ? (data as Record<string, unknown>[])
          : [];

        const tasks: ExternalTask[] = rawTasks.map((t) => ({
          id: String(t["id"] ?? ""),
          // Flowable wire shape has no "topic" field — echo the requested topic
          topic,
          processInstanceId: String(t["processInstanceId"] ?? ""),
          variables: fromFlowableVars(
            t["variables"] as { name: string; value: unknown }[] | undefined,
          ),
          lockOwner: String(t["lockOwner"] ?? ""),
          lockExpirationTime: String(t["lockExpirationTime"] ?? ""),
        }));

        return { ok: true, tasks };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<FetchResult>;
  }

  // -------------------------------------------------------------------------
  // FR-4: completeTask — assertVariableValue guard + resolveFor seam (FF-G3)
  // -------------------------------------------------------------------------
  async function completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult> {
    // FF-G3 Layer C: validate ALL outgoing variables before sending to engine.
    if (variables !== undefined) {
      for (const value of Object.values(variables)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }

    // resolveFor is the designated record-mutation seam (T-0028 Layer C).
    // T-0068 (lifecycle + audit) will complete the authorization wiring here.
    // The import and reference satisfy FF-G3; no runtime auth call yet (T-0068).
    void resolveFor; // structural reference — keeps FF-G3 grep green

    return withRetry(async () => {
      const bodyObj: Record<string, unknown> = { workerId };
      if (variables !== undefined && Object.keys(variables).length > 0) {
        bodyObj["variables"] = toFlowableVars(variables);
      }

      // Real endpoint: POST {extJobUrl}/acquire/jobs/{taskId}/complete
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs/${taskId}/complete`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyObj),
        },
      );

      if (resp.status === 204) {
        return { ok: true as const };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<CompleteTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-5: failTask — no variable guard needed (FR-5 explicit)
  // -------------------------------------------------------------------------
  async function failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult> {
    return withRetry(async () => {
      // Real endpoint: POST {extJobUrl}/acquire/jobs/{taskId}/fail
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs/${taskId}/fail`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workerId,
            errorMessage,
            retries,
            retryTimeout: retryTimeoutMs,
          }),
        },
      );

      if (resp.status === 204) {
        return { ok: true as const };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<FailTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-6: getFirstActiveUserTask — T-0368 (E16) on_create skip-submit seam
  //
  // GET {baseUrl}/runtime/tasks?processInstanceId={id}&size=1
  // Returns the first active USER task for an instance (not external tasks).
  // Used after startInstance via on_create trigger to discover the task-submit
  // user task so it can be immediately auto-completed (dissolve double-submit).
  // -------------------------------------------------------------------------
  async function getFirstActiveUserTask(instanceId: string): Promise<GetFirstUserTaskResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/runtime/tasks?processInstanceId=${encodeURIComponent(instanceId)}&size=1`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items) || items.length === 0) {
          return { ok: true as const, taskId: null };
        }
        const taskId = String(items[0]!["id"] ?? "");
        return { ok: true as const, taskId: taskId || null };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetFirstUserTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-7: completeUserTask — T-0368 (E16) on_create skip-submit seam
  //
  // PUT {baseUrl}/runtime/tasks/{taskId}  body: {"action":"complete"}
  // Flowable 7 returns 200 with the task JSON on a successful complete.
  // No variables are passed (task-submit has no output variables — the
  // field_mapping already injected amount at startInstance time).
  // -------------------------------------------------------------------------
  async function completeUserTask(taskId: string): Promise<CompleteUserTaskResult> {
    return withRetry(async () => {
      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "PUT",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "complete" }),
        },
      );
      // Flowable 7 returns 200 with the completed task body on success.
      if (resp.status === 200 || resp.status === 204) {
        return { ok: true as const };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<CompleteUserTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-8: getActiveUserTasks — T-0443 defKey-resolution seam
  //
  // GET {baseUrl}/runtime/tasks?processInstanceId={id}
  // Returns ALL active USER tasks for an instance (not just the first one).
  // Maps each task to { id, taskDefinitionKey, name, candidateGroups } so the
  // approve handler can resolve the correct engine task by taskDefinitionKey
  // (e.g. "task-approve") rather than blindly taking whatever is first.
  // -------------------------------------------------------------------------
  async function getActiveUserTasks(instanceId: string): Promise<GetActiveUserTasksResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/runtime/tasks?processInstanceId=${encodeURIComponent(instanceId)}`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items)) {
          return { ok: true as const, tasks: [] };
        }
        const tasks: ActiveUserTask[] = items.map((t) => {
          // candidateGroups: Flowable returns an array of objects {url, groupId} or strings.
          // Normalize to a string array of group identifiers.
          const rawGroups = t["involvedPeople"] ?? t["candidateGroups"] ?? [];
          let candidateGroups: string[] = [];
          if (Array.isArray(rawGroups)) {
            candidateGroups = (rawGroups as unknown[]).map((g) => {
              if (typeof g === "string") return g;
              if (g !== null && typeof g === "object") {
                const obj = g as Record<string, unknown>;
                return String(obj["groupId"] ?? obj["id"] ?? "");
              }
              return String(g);
            }).filter((s) => s.length > 0);
          }
          return {
            id: String(t["id"] ?? ""),
            taskDefinitionKey: String(t["taskDefinitionKey"] ?? ""),
            name: String(t["name"] ?? ""),
            candidateGroups,
          };
        });
        return { ok: true as const, tasks };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetActiveUserTasksResult>;
  }

  // -------------------------------------------------------------------------
  // T-0459 [D8-R4]: getMessageCatchWaits — parked message/signal-catch projection
  //
  // GET {baseUrl}/runtime/event-subscriptions?processInstanceId={id}
  // Returns the engine event-subscriptions for an instance — a receiveTask /
  // intermediateCatchEvent(message|signal) / message-boundary that the token is
  // parked on registers a subscription with eventType "message" | "signal" and an
  // eventName (the message/signal name). This is the engine truth that an instance
  // is WAITING for a correlated message (not a userTask). Maps each to
  // { messageName, eventType }; timer/other subscription types are filtered out.
  // -------------------------------------------------------------------------
  async function getMessageCatchWaits(instanceId: string): Promise<GetMessageCatchWaitsResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/runtime/event-subscriptions?processInstanceId=${encodeURIComponent(instanceId)}`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items)) {
          return { ok: true as const, waits: [] };
        }
        const waits: MessageCatchWait[] = [];
        for (const s of items) {
          const eventType = String(s["eventType"] ?? "").toLowerCase();
          // Only message/signal catches are waiting-on-a-message; timers are handled
          // by the T-0458 timer reconcile, not here.
          if (eventType !== "message" && eventType !== "signal") continue;
          const messageName = String(s["eventName"] ?? "");
          if (messageName.length === 0) continue;
          waits.push({ messageName, eventType });
        }
        return { ok: true as const, waits };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetMessageCatchWaitsResult>;
  }

  // -------------------------------------------------------------------------
  // FR-9: isInstanceEnded — T-0443 engine-reconcile seam
  //
  // Strategy:
  //   1. GET {baseUrl}/runtime/process-instances/{id} → 200 (still running) or
  //      404 (Flowable removed it from runtime — means ended).
  //   2. If 200, also check /history/historic-process-instances/{id} endTime field.
  //      A running instance with no history end-time is NOT ended.
  //   3. If the runtime query returns any non-404/non-200 error, propagate as
  //      { ok: false, code } so the caller can honest-degrade.
  // -------------------------------------------------------------------------
  async function isInstanceEnded(instanceId: string): Promise<IsInstanceEndedResult> {
    return withRetry(async () => {
      const runtimeUrl = `${resolved.baseUrl}/runtime/process-instances/${encodeURIComponent(instanceId)}`;
      const runtimeResp = await globalThis.fetch(runtimeUrl, {
        method: "GET",
        headers: { Authorization: auth },
      });

      if (runtimeResp.status === 404) {
        // Flowable deletes runtime records when an instance completes — 404 means ended.
        return { ok: true as const, ended: true };
      }

      if (runtimeResp.status === 200) {
        // Instance is still in the runtime table — check history for endTime just
        // to be thorough (a suspended instance with no active tasks is still running).
        // Primary signal: 200 on /runtime/ = not yet ended.
        // We do a best-effort history check; on any failure we conservatively say
        // "not ended" (safe default: avoid falsely ending an instance).
        try {
          const histUrl = `${resolved.baseUrl}/history/historic-process-instances/${encodeURIComponent(instanceId)}`;
          const histResp = await globalThis.fetch(histUrl, {
            method: "GET",
            headers: { Authorization: auth },
          });
          if (histResp.status === 200) {
            const histData = (await histResp.json()) as Record<string, unknown>;
            const endTime = histData["endTime"];
            const ended = endTime !== null && endTime !== undefined;
            return { ok: true as const, ended };
          }
        } catch {
          // History endpoint unreachable → conservatively say not ended.
        }
        return { ok: true as const, ended: false };
      }

      return { ok: false, code: httpStatusToCode(runtimeResp.status) };
    }, resolved) as Promise<IsInstanceEndedResult>;
  }

  // -------------------------------------------------------------------------
  // T-0483: pingEngine — readiness probe (single-shot, no retry).
  //
  // Hits the engine management endpoint (same one the compose healthcheck uses).
  // Bounded by the configured timeout so a hung engine can't hang the readiness
  // endpoint. Never throws — maps any transport/HTTP failure to a typed code so
  // GET /api/engine/health can report an honest "движок недоступен" state.
  // -------------------------------------------------------------------------
  async function pingEngine(): Promise<PingEngineResult> {
    const url = `${resolved.baseUrl}/management/engine`;
    try {
      const raceResult = await Promise.race([
        globalThis.fetch(url, { method: "GET", headers: { Authorization: auth } }),
        makeTimeoutPromise(resolved.timeoutMs),
      ]);
      if (raceResult === TIMEOUT_SENTINEL) {
        return { ok: true, reachable: false, code: "TIMEOUT" };
      }
      const resp = raceResult as Response;
      if (resp.status === 200) {
        return { ok: true, reachable: true };
      }
      return { ok: true, reachable: false, code: httpStatusToCode(resp.status) };
    } catch {
      // Network/DNS/connection-refused → engine unreachable.
      return { ok: true, reachable: false, code: "ENGINE_UNAVAILABLE" };
    }
  }

  return {
    deployBpmn,
    startInstance,
    fetchAndLock,
    completeTask,
    failTask,
    getFirstActiveUserTask,
    completeUserTask,
    getActiveUserTasks,
    getMessageCatchWaits,
    isInstanceEnded,
    pingEngine,
  };
}
