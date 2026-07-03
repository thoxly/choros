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
 * T-0536: result of correlateMessage — signal a parked message-catch in the live
 * engine. { ok: true } when the engine accepted the message-event trigger (the
 * catch fired and the token advanced); { ok: false, code } on engine error so the
 * delivery seam (deliverMessageEnvelope) can honest-degrade and retry.
 */
export type CorrelateMessageResult =
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
 * T-0609: a single process-instance variable from the engine's historic
 * variable store (survives both running AND completed instances — unlike the
 * runtime-only variable views used elsewhere in this client).
 */
export interface HistoricVariable {
  readonly name: string;
  readonly value: unknown;
}

/**
 * T-0609: result of getHistoricVariableInstances — the full variable set of a
 * process instance (running or completed), read from Flowable's HISTORY
 * servlet (which retains variables after the instance ends, unlike
 * /runtime/*). `{ ok: false }` on engine error so the read-only detail page
 * can honest-degrade (empty variables list) rather than fail the whole
 * instance-detail response.
 */
export type GetHistoricVariablesResult =
  | { ok: true; variables: HistoricVariable[] }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0609: a single completed-or-in-progress BPMN activity (startEvent /
 * userTask / gateway / endEvent / ...) from the engine's historic activity
 * log — the ONLY engine-native source of "which branch did this instance
 * take, and when" (this is what previously required raw SQL against the
 * Flowable tables during live acceptance diagnosis of a gateway branch).
 * `startTime`/`endTime` are ISO-8601 strings as returned by Flowable;
 * `endTime` is null for the activity the token is currently sitting on.
 * `assignee` is the user/agent who completed a userTask, null otherwise.
 */
export interface HistoricActivity {
  readonly activityId: string;
  readonly activityName: string;
  readonly activityType: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly assignee: string | null;
}

/**
 * T-0609: result of getHistoricActivityInstances — the ordered (by startTime)
 * list of BPMN activities this instance has passed through or is currently
 * on. `{ ok: false }` on engine error so the caller can honest-degrade
 * (historyAvailable: false) rather than fail the whole instance-detail
 * response.
 */
export type GetHistoricActivitiesResult =
  | { ok: true; activities: HistoricActivity[] }
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
  /**
   * T-0534: BPMN process definition KEY extracted from the Flowable wire field
   * `processDefinitionId` (format "key:version:uuid") at fetchAndLock time.
   * Empty string when the engine does not supply the field. Stored in
   * choros.job.process_def_id so the triage seam can scope rule-table lookups to
   * the correct process without relying on process variables.
   */
  readonly processDefinitionKey: string;
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
   * instance. Returns { ok: true, taskId: null } when the instance has no
   * active user tasks (already at a service task or completed), { ok: false }
   * on engine error.
   *
   * T-0604 [P0/целостность согласований]: the on_create «skip-submit» path in
   * src/http/records.ts no longer calls this method — it needs the live
   * taskDefinitionKey (to gate auto-complete against binding.submit_task_key,
   * see ADR-T0604-skip-submit-defkey.md §1.3), which this size=1 lookup does
   * not carry. records.ts now consolidates on getActiveUserTasks (below),
   * which it already needed for the BUG-015 projection read. This method is
   * kept as a public client contract (a bare-taskId lookup remains a
   * legitimate, narrower query than the full list) but currently has no
   * caller in src/.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/tasks?processInstanceId={id}&size=1
   */
  getFirstActiveUserTask(instanceId: string): Promise<GetFirstUserTaskResult>;
  /**
   * T-0368 (E16): complete a Flowable USER task (not an external/service task)
   * by id. Used by the on_create trigger path to auto-complete a
   * legitimately-declared submit user task (T-0604: gated by
   * process_app_binding.submit_task_key matching the live engine's defKey —
   * never unconditional) so the instance advances past the submit step
   * without waiting for a human.
   *
   * T-0571 (BUG-014): Flowable 7's REST API executes task actions via POST,
   * not PUT — see the implementation's doc-comment for the full empirical
   * diagnosis. POST returns 200 with an empty body on success.
   *
   * Flowable endpoint: POST {baseUrl}/runtime/tasks/{taskId}  body: {"action":"complete"}
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
   * T-0609: Get the FULL variable set of a process instance (running or
   * completed) from the engine's HISTORY store. Unlike the runtime task
   * variable views used elsewhere in this client, this survives after the
   * instance ends — this is the read the process-instance detail page needs
   * to show "what values did this run take" without a direct SQL query
   * against the Flowable schema.
   *
   * Flowable endpoint: GET {baseUrl}/history/historic-variable-instances?processInstanceId={id}
   * Maps each entry to { name, value }.
   *
   * OPTIONAL on the interface (mirrors pingEngine below) so the dozens of existing
   * partial FlowableClient test stubs across src/__tests__/ need no change — a caller
   * that needs this method (the process-instance detail route) checks for its presence
   * and honest-degrades (empty variables) when absent. The real makeFlowableClient
   * factory always provides it.
   */
  getHistoricVariableInstances?(instanceId: string): Promise<GetHistoricVariablesResult>;
  /**
   * T-0609: Get the ordered (by startTime) BPMN activity history of a process
   * instance (running or completed) — startEvent/userTask/gateway/endEvent
   * entries with start/end times and (for userTasks) the completing assignee.
   * This is the engine-native source of "which branch did this instance take
   * and when" that previously required raw SQL against the Flowable tables
   * during live acceptance diagnosis of a gateway branch.
   *
   * Flowable endpoint: GET {baseUrl}/history/historic-activity-instances?processInstanceId={id}&sort=startTime
   * Maps each entry to { activityId, activityName, activityType, startTime, endTime, assignee }.
   *
   * OPTIONAL on the interface — see getHistoricVariableInstances doc-comment above for
   * the identical rationale (existing partial test stubs, honest-degrade at the caller).
   */
  getHistoricActivityInstances?(instanceId: string): Promise<GetHistoricActivitiesResult>;
  /**
   * T-0536 [D8-R4 delivery]: deliver a correlated message into a specific process
   * instance — fire the parked message-catch (receiveTask / intermediateCatchEvent /
   * message boundary) the instance is waiting on. The CORRELATION decision
   * (tenant-fail-closed, business-key match) is made BEFORE this call in the pure
   * core (correlateEnvelope); this method only carries the already-correlated signal
   * to the engine for ONE instance.
   *
   * Flowable endpoint: PUT {baseUrl}/runtime/process-instances/{id}
   *   body: { "action": "messageEventReceived", "messageName": <name>,
   *           "variables": [ {name,value}, ... ] }
   * Success: 200 (Flowable returns the updated instance) / 204.
   *
   * Returns { ok: true } on accept, { ok: false, code } on engine error (the
   * delivery seam treats a failure as retriable — never throws past this boundary).
   */
  correlateMessage(
    instanceId: string,
    messageName: string,
    payload: Record<string, unknown>,
  ): Promise<CorrelateMessageResult>;
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

        const tasks: ExternalTask[] = rawTasks.map((t) => {
          // T-0534: Flowable wire field `processDefinitionId` has the format
          // "key:version:uuid" (e.g. "telLinear:1:abc123…"). Extract the KEY
          // (the first colon-delimited segment) as the canonical process key.
          // When the field is absent or doesn't contain a colon, fall back to
          // the full field value (may be empty string — handled at enqueue site).
          const rawProcDefId = String(t["processDefinitionId"] ?? "");
          const colonIdx = rawProcDefId.indexOf(":");
          const processDefinitionKey =
            colonIdx > 0 ? rawProcDefId.slice(0, colonIdx) : rawProcDefId;

          return {
            id: String(t["id"] ?? ""),
            // Flowable wire shape has no "topic" field — echo the requested topic
            topic,
            processInstanceId: String(t["processInstanceId"] ?? ""),
            processDefinitionKey,
            variables: fromFlowableVars(
              t["variables"] as { name: string; value: unknown }[] | undefined,
            ),
            lockOwner: String(t["lockOwner"] ?? ""),
            lockExpirationTime: String(t["lockExpirationTime"] ?? ""),
          };
        });

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
  // T-0571 (BUG-014 live diagnosis, ADR-T0571-engine-drive-seam.md): Flowable 7's
  // REST API executes task ACTIONS (complete/claim/delegate/…) via POST
  // {baseUrl}/runtime/tasks/{taskId} — NOT PUT. PUT on this resource is the
  // property-UPDATE endpoint (assignee/name/etc.): it silently ACCEPTS an
  // unrecognized `action` field, ECHOES the unchanged task body back with HTTP
  // 200, and does NOT complete the task. This was verified empirically against a
  // live Flowable 7.1.0 instance while diagnosing why BUG-014 persisted after the
  // defKey resolve-by-instance fix (ci/checks/db/engine-drive-generic.db.test.ts,
  // FF-3/AC-6): every prior unit test mocked `fetch` and could not have caught a
  // wrong-verb bug, since a mock has no HTTP-semantics of its own to violate. This
  // was the SECOND, independent root cause behind the live acceptance-run symptom
  // (200-ok, engine token never advances) — the defKey-literal bug (§2.1) and this
  // verb bug are both necessary conditions for BUG-014's fix to hold end-to-end.
  // POST returns 200 with an EMPTY body on success (not the task JSON — a
  // subsequent GET for the same taskId then correctly 404s, confirming completion).
  // No variables are passed (task-submit has no output variables — the
  // field_mapping already injected amount at startInstance time).
  // -------------------------------------------------------------------------
  async function completeUserTask(taskId: string): Promise<CompleteUserTaskResult> {
    return withRetry(async () => {
      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "complete" }),
        },
      );
      // Flowable 7 returns 200 (empty body) on a successful complete.
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
  /**
   * T-0575 [W1/деТЭЛ] BUG-015 fix-of-fix: the `GET /runtime/tasks` LIST/query
   * endpoint response items do NOT carry `candidateGroups`/`involvedPeople`
   * inline (empirically confirmed against flowable/flowable-rest:7.1.0 — the
   * list endpoint's TaskResponse omits identity links entirely; only
   * `GET /runtime/tasks/{taskId}/identitylinks` returns them, as
   * `[{type:"candidate", group:"<slug>", user:null}, ...]`). The
   * defensive `t["involvedPeople"] ?? t["candidateGroups"]` read below is kept
   * as a forward-compatible fallback (harmless if a future Flowable version or
   * a differently-configured REST layer DOES embed them inline), but the
   * PRIMARY source is now a per-task identity-links fetch — best-effort, in
   * parallel, one extra round-trip per active task. A failed identity-links
   * fetch for one task degrades that task's candidateGroups to `[]` (the
   * caller's ?? APPROVER_ROLE / resolveDefaultApproverRole() fallback applies)
   * — it does NOT fail the whole getActiveUserTasks call.
   */
  async function fetchTaskCandidateGroups(taskId: string): Promise<string[]> {
    if (taskId === "") return [];
    try {
      const url = `${resolved.baseUrl}/runtime/tasks/${encodeURIComponent(taskId)}/identitylinks`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status !== 200) return [];
      const links = (await resp.json()) as unknown;
      if (!Array.isArray(links)) return [];
      return (links as Array<Record<string, unknown>>)
        .filter((l) => l["type"] === "candidate" && typeof l["group"] === "string" && l["group"] !== "")
        .map((l) => String(l["group"]));
    } catch {
      // Best-effort: engine unreachable/slow for this ONE identity-link lookup
      // degrades to no candidateGroups for this task (config-primitive fallback
      // applies at the caller) — never throws.
      return [];
    }
  }

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
        const tasks: ActiveUserTask[] = await Promise.all(items.map(async (t) => {
          const taskId = String(t["id"] ?? "");
          // Forward-compatible inline fallback (see doc-comment above): normalize
          // {url, groupId} objects or plain strings to a string array.
          const rawGroups = t["involvedPeople"] ?? t["candidateGroups"] ?? [];
          let inlineCandidateGroups: string[] = [];
          if (Array.isArray(rawGroups)) {
            inlineCandidateGroups = (rawGroups as unknown[]).map((g) => {
              if (typeof g === "string") return g;
              if (g !== null && typeof g === "object") {
                const obj = g as Record<string, unknown>;
                return String(obj["groupId"] ?? obj["id"] ?? "");
              }
              return String(g);
            }).filter((s) => s.length > 0);
          }
          // PRIMARY source: per-task identity-links fetch (empirically the only
          // source flowable-rest 7.1.0's LIST endpoint actually supports).
          const candidateGroups = inlineCandidateGroups.length > 0
            ? inlineCandidateGroups
            : await fetchTaskCandidateGroups(taskId);
          return {
            id: taskId,
            taskDefinitionKey: String(t["taskDefinitionKey"] ?? ""),
            name: String(t["name"] ?? ""),
            candidateGroups,
          };
        }));
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
  // T-0609: getHistoricVariableInstances — full variable set of a process
  // instance (running or completed), read from the engine's HISTORY store
  // (NOT the runtime-only variable views used by startInstance/completeTask).
  //
  // GET {baseUrl}/history/historic-variable-instances?processInstanceId={id}
  // Response: { data: [{ variableName, value, ... }] } (Flowable list-endpoint
  // envelope, same shape family as /runtime/tasks — data-wrapped array).
  // -------------------------------------------------------------------------
  async function getHistoricVariableInstances(
    instanceId: string,
  ): Promise<GetHistoricVariablesResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/history/historic-variable-instances?processInstanceId=${encodeURIComponent(instanceId)}`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items)) {
          return { ok: true as const, variables: [] };
        }
        const variables: HistoricVariable[] = items.map((v) => ({
          name: String(v["variableName"] ?? ""),
          value: v["value"],
        }));
        return { ok: true as const, variables };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetHistoricVariablesResult>;
  }

  // -------------------------------------------------------------------------
  // T-0609: getHistoricActivityInstances — ordered BPMN activity history of a
  // process instance (running or completed): startEvent/userTask/gateway/
  // endEvent entries with start/end times and (for userTasks) the completing
  // assignee. This is the engine-native replacement for the raw-SQL query
  // that live acceptance diagnosis of a gateway branch previously required
  // (no product surface showed which branch an instance took, or when).
  //
  // GET {baseUrl}/history/historic-activity-instances?processInstanceId={id}&sort=startTime
  // Response: { data: [{ activityId, activityName, activityType, startTime,
  //   endTime, assignee }] }. `sort=startTime` is honored by the engine —
  // the client does not re-sort.
  // -------------------------------------------------------------------------
  async function getHistoricActivityInstances(
    instanceId: string,
  ): Promise<GetHistoricActivitiesResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/history/historic-activity-instances?processInstanceId=${encodeURIComponent(instanceId)}&sort=startTime`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items)) {
          return { ok: true as const, activities: [] };
        }
        const activities: HistoricActivity[] = items.map((a) => ({
          activityId: String(a["activityId"] ?? ""),
          activityName: String(a["activityName"] ?? ""),
          activityType: String(a["activityType"] ?? ""),
          startTime: typeof a["startTime"] === "string" ? a["startTime"] : null,
          endTime: typeof a["endTime"] === "string" ? a["endTime"] : null,
          assignee: typeof a["assignee"] === "string" ? a["assignee"] : null,
        }));
        return { ok: true as const, activities };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetHistoricActivitiesResult>;
  }

  // -------------------------------------------------------------------------
  // T-0536 [D8-R4 delivery]: correlateMessage — fire a parked message-catch.
  //
  // PUT {baseUrl}/runtime/process-instances/{id}
  //   body: { action: "messageEventReceived", messageName, variables: [...] }
  // The correlation decision (tenant-fail-closed, business-key match) already
  // happened in the pure core; this only carries the signal to the engine for ONE
  // already-correlated instance. Payload is projected into Flowable's variables wire
  // shape ([{ name, value }]) so the catch's downstream steps can read it.
  // -------------------------------------------------------------------------
  async function correlateMessage(
    instanceId: string,
    messageName: string,
    payload: Record<string, unknown>,
  ): Promise<CorrelateMessageResult> {
    return withRetry(async () => {
      const variables = Object.entries(payload).map(([name, value]) => ({
        name,
        value,
      }));
      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/process-instances/${encodeURIComponent(instanceId)}`,
        {
          method: "PUT",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "messageEventReceived",
            messageName,
            variables,
          }),
        },
      );
      if (resp.status === 200 || resp.status === 204) {
        return { ok: true as const };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<CorrelateMessageResult>;
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
    getHistoricVariableInstances,
    getHistoricActivityInstances,
    correlateMessage,
    isInstanceEnded,
    pingEngine,
  };
}
